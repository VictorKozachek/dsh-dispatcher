/**
 * Ротация журналов и очистка хранилища (задача 033).
 *
 * Один алгоритм для `audit.jsonl` и `log.jsonl`: файл растёт до `maxBytes`, затем
 * атомарно уезжает в `.1`, старые сдвигаются вглубь; сверх `keep` — удаляются.
 * Последняя запись не теряется: ротация делается ДО append, и если она не
 * удалась, append пишется в текущий файл (журнал важнее порядка).
 *
 * Права: всё, что создаём/переименовываем, — `600` (в журналах бывают id).
 */

import path from "node:path";

/** 5 МиБ — размер, после которого журнал уезжает в `.1`. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Сколько ротированных файлов держим. */
export const DEFAULT_KEEP = 5;

const noop = () => {};

/** Пути ротированных файлов: `.1` … `.keep`. */
export function rotatedPaths(file, keep = DEFAULT_KEEP) {
  const count = Math.max(0, Math.floor(Number.isFinite(keep) ? keep : DEFAULT_KEEP));
  return Array.from({ length: count }, (_, index) => `${file}.${index + 1}`);
}

/** Поставить 600, молча игнорируя ошибки (файл мог исчезнуть). */
export function chmod600(fsImpl, target, log = noop) {
  try {
    fsImpl.chmodSync(target, 0o600);
  } catch (error) {
    if (error?.code !== "ENOENT") log(`ротация: chmod 600 для ${target} не удался (${error?.message ?? error})`);
  }
}

/**
 * Ротировать файл, если `size + incoming > maxBytes`.
 *
 * @returns `{rotated: boolean, target?: string, reason?: string}` — без исключений.
 */
export function rotateIfNeeded(fsImpl, file, incoming = 0, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, log = noop } = {}) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
  let size = 0;
  try {
    size = fsImpl.statSync(file).size;
  } catch (error) {
    if (error?.code === "ENOENT") return { rotated: false, reason: "absent" };
    log(`ротация: stat ${file} не удался (${error?.message ?? error})`);
    return { rotated: false, reason: "stat-failed" };
  }
  if (size <= 0 || size + incoming <= limit) return { rotated: false, reason: "fits" };

  const targets = rotatedPaths(file, keep);
  if (targets.length === 0) {
    // keep: 0 — храним только текущий файл, старое удаляем.
    try {
      fsImpl.rmSync(file, { force: true });
      return { rotated: true, reason: "truncated" };
    } catch (error) {
      log(`ротация: очистить ${file} не удалось (${error?.message ?? error})`);
      return { rotated: false, reason: "truncate-failed" };
    }
  }

  try {
    // Самый старый удаляем, .N-1 → .N, current → .1. Всё — rename, без копий.
    fsImpl.rmSync(targets[targets.length - 1], { force: true });
    for (let index = targets.length - 1; index >= 1; index -= 1) {
      try {
        fsImpl.renameSync(targets[index - 1], targets[index]);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      chmod600(fsImpl, targets[index], log);
    }
    fsImpl.renameSync(file, targets[0]);
    chmod600(fsImpl, targets[0], log);
    log(`ротация: ${path.basename(file)} превысил ${limit} байт — в ${path.basename(targets[0])}`);
    return { rotated: true, target: targets[0] };
  } catch (error) {
    // Ротация не удалась — не теряем запись: пусть append допишет в текущий файл.
    log(`ротация: ${file} не ротирован (${error?.message ?? error})`);
    return { rotated: false, reason: "failed" };
  }
}

/**
 * Очистка старых ротированных файлов: для каждого base оставить последние
 * `keep`, остальные удалить. `dryRun` только перечисляет.
 */
export function vacuum(fsImpl, { dir, bases = ["audit.jsonl", "log.jsonl"], keep = DEFAULT_KEEP, dryRun = false, log = noop } = {}) {
  const removed = [];
  const kept = [];
  // Мусор в аргументах не должен удалять лишнего: keep — только целое ≥ 0,
  // bases — только массив имён.
  const effectiveKeep = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : DEFAULT_KEEP;
  const list = Array.isArray(bases) ? bases.filter((base) => typeof base === "string" && base !== "") : ["audit.jsonl", "log.jsonl"];
  for (const base of list) {
    const file = path.join(dir, base);
    const candidates = [];
    const prefix = `${base}.`;
    let names = [];
    try {
      names = fsImpl.readdirSync(dir);
    } catch (error) {
      log(`вакуум: прочитать ${dir} не удалось (${error?.message ?? error})`);
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (!/^\d+$/.test(suffix)) continue;
      const target = path.join(dir, name);
      try {
        const stat = fsImpl.statSync(target);
        candidates.push({ path: target, size: stat.size, index: Number(suffix) });
      } catch (error) {
        if (error?.code !== "ENOENT") log(`вакуум: stat ${target} не удался (${error?.message ?? error})`);
      }
    }
    candidates.sort((a, b) => a.index - b.index);
    // Нумерация ротаций: .1 — самая свежая, .N — самая старая (так их двигает
    // rotateIfNeeded). «Очистка старых» оставляет НАИМЕНЬШИЕ индексы .1..keep,
    // а удаляет более старые .keep+1…; дырка в нумерации ничего не меняет.
    const drop = candidates.slice(Math.max(0, effectiveKeep));
    for (const item of candidates) {
      if (drop.includes(item)) {
        if (!dryRun) {
          try {
            fsImpl.rmSync(item.path, { force: true });
          } catch (error) {
            log(`вакуум: удалить ${item.path} не удалось (${error?.message ?? error})`);
            continue;
          }
        }
        removed.push(item);
      } else {
        kept.push(item);
      }
    }
  }
  return {
    dryRun,
    removed,
    kept,
    freedBytes: removed.reduce((sum, item) => sum + item.size, 0),
  };
}
