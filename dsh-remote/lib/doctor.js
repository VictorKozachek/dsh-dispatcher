/**
 * Health-модель `/remote doctor` (задача 030).
 *
 * Диагностика отвечает на два вопроса: «что сломалось» и «что делать». Модель
 * машиночитаемая: `{status, exitCode, checks: [{id, status, detail, action?}]}`,
 * статус — худший из проверок, код возврата — 0/1/2 (ok/warn/fail).
 *
 * Модуль чистый: сервисы (store, credentials, транспорт, релей, устойчивость)
 * инжектируются, сети и реальных часов здесь нет. Секреты в `detail` не
 * попадают: только имена ссылок, источники и права.
 */

import { DEFAULT_LANG, normalizeLang, t } from "./i18n.js";

/** Язык текущего вывода doctor (049). */
let doctorLang = DEFAULT_LANG;

function dt(key, params = {}) {
  return t(key, params, doctorLang);
}

/** Статусы проверок в порядке возрастания серьёзности. */
export const DOCTOR_STATUS = Object.freeze(["ok", "warn", "fail"]);

/** Код возврата для скриптов: 0 — ok, 1 — warn, 2 — fail. */
export const EXIT_CODES = Object.freeze({ ok: 0, warn: 1, fail: 2 });

/**
 * Одна проверка. Поля фиксированы: `id` (машинный), `status`, `detail`, `action`
 * (что делать; обязателен для `fail`).
 */
export function createCheck({ id, status = "ok", detail = "", action = undefined } = {}) {
  if (typeof id !== "string" || id === "") throw new TypeError(dt("doctor.createCheck.1"));
  if (!DOCTOR_STATUS.includes(status)) throw new TypeError(dt("doctor.createCheck.2", { p0: status }));
  if (status === "fail" && (typeof action !== "string" || action === "")) {
    throw new TypeError(dt("doctor.createCheck.3", { p0: id }));
  }
  return {
    id,
    status,
    detail: String(detail ?? ""),
    ...(typeof action === "string" && action !== "" ? { action } : {}),
  };
}

/**
 * Id проверок doctor, которые умеют возвращать `fail` (задача 036).
 *
 * Контракт с RUNBOOK: у каждого такого кода есть раздел в `docs/RUNBOOK.md`
 * (маркер `<!-- doctor-fail: <id> -->`), соответствие проверяется тестом. Если
 * добавляешь новую fail-проверку — добавь id сюда и раздел в RUNBOOK.
 * У `credentials` id в отчёте — `credentials:<ref>`, здесь базовый.
 */
export const DOCTOR_FAIL_IDS = Object.freeze([
  "token",
  "getme",
  "state",
  "credentials",
  "relay",
  "schema",
  "timers",
]);

/** Худший статус из списка: ok < warn < fail. */
export function worstStatus(checks) {
  let worst = "ok";
  for (const check of Array.isArray(checks) ? checks : []) {
    if (check?.status === "fail") return "fail";
    if (check?.status === "warn") worst = "warn";
  }
  return worst;
}

export function exitCodeFor(status) {
  return EXIT_CODES[status] ?? EXIT_CODES.fail;
}

/** Отчёт: статус, код возврата и проверки (порядок проверок сохраняем). */
export function buildReport(checks) {
  const list = (Array.isArray(checks) ? checks : []).map((check) => createCheck(check));
  const status = worstStatus(list);
  return { status, exitCode: exitCodeFor(status), checks: list };
}

/** Машиночитаемый JSON: стабильная структура для скриптов и панели (036). */
export function serializeReport(report) {
  return JSON.stringify({
    status: report.status,
    exitCode: report.exitCode,
    checks: report.checks.map((check) => ({
      id: check.id,
      status: check.status,
      detail: check.detail,
      ...(check.action === undefined ? {} : { action: check.action }),
    })),
  });
}

/** Человеческий вывод: те же машинные id плюс «→ что делать», итог и код. */
export function formatHealthReport(report, lang = DEFAULT_LANG) {
  doctorLang = normalizeLang(lang) ?? DEFAULT_LANG;
  const lines = report.checks.map((check) => {
    const head = `[${check.status}] ${check.id}: ${check.detail}`;
    return check.action === undefined ? head : `${head}\n      → ${check.action}`;
  });
  const failed = report.checks.filter((check) => check.status === "fail").length;
  const warned = report.checks.filter((check) => check.status === "warn").length;
  const summary = failed > 0
    ? dt("doctor.formatHealthReport.1", { p0: failed, p1: warned })
    : warned > 0
      ? dt("doctor.formatHealthReport.2", { p0: warned })
      : dt("doctor.formatHealthReport.3");
  return [...lines, "", lastLine(summary, report.exitCode)].join("\n");
}

function lastLine(summary, exitCode) {
  return dt("doctor.lastLine.1", { p0: summary, p1: exitCode });
}

/** Преобразовать legacy-проверки 010 в новую модель: старые заголовки узнаваемы. */
export function fromLegacyChecks(checks) {
  const ids = {
    "плагин": "plugin",
    "токен": "token",
    "getMe": "getme",
    "поллеры": "lock",
    "канал": "channel",
    "состояние": "state",
    "права": "permissions",
  };
  return (Array.isArray(checks) ? checks : []).map((check) => createCheck({
    id: ids[check.title] ?? String(check.title ?? "legacy"),
    status: check.level,
    detail: `${check.title}: ${check.detail ?? ""}`,
    // Legacy fail без hint не должен ломать модель: даём защитный action.
    action: check.hint ?? (check.level === "fail" ? dt("doctor.fromLegacyChecks.7") : undefined),
  }));
}

/**
 * Дополнительные проверки 030: credentials, relay, schema, timers.
 *
 * Все сервисы необязательны: их отсутствие не бросает исключение, а даёт
 * честный warn/fail с action.
 */
export async function runHealthChecks({
  legacyChecks = [],
  credentials = null,
  tokenRefs = [],
  relay = null,
  store = null,
  reliability = null,
  supportedSchemaVersion = null,
  lang = DEFAULT_LANG,
} = {}) {
  doctorLang = normalizeLang(lang) ?? DEFAULT_LANG;
  const checks = [...fromLegacyChecks(legacyChecks)];

  // --- credentials: ссылки, источник, writable ---------------------------------
  const refs = (Array.isArray(tokenRefs) ? tokenRefs : []).filter((ref) => typeof ref === "string" && ref !== "");
  if (credentials === null || typeof credentials?.describe !== "function") {
    checks.push(createCheck({
      id: "credentials",
      status: "warn",
      detail: dt("doctor.runHealthChecks.1"),
      action: dt("doctor.runHealthChecks.2"),
    }));
  } else if (refs.length === 0) {
    checks.push(createCheck({ id: "credentials", status: "ok", detail: dt("doctor.runHealthChecks.3") }));
  } else {
    for (const ref of refs) {
      let info = null;
      try {
        info = await credentials.describe(ref);
      } catch {
        info = null;
      }
      if (info === null) {
        checks.push(createCheck({
          id: `credentials:${ref}`,
          status: "warn",
          detail: dt("doctor.runHealthChecks.4", { p0: ref }),
          action: dt("doctor.runHealthChecks.5"),
        }));
        continue;
      }
      const source = typeof info.source === "string" ? info.source : "unknown";
      // present/configured — авторитетные поля; source без них наличия не доказывает.
      const present = info.present !== undefined || info.configured !== undefined
        ? info.present === true || info.configured === true
        : info.source !== null && info.source !== undefined;
      if (!present) {
        checks.push(createCheck({
          id: `credentials:${ref}`,
          status: "fail",
          detail: dt("doctor.runHealthChecks.6", { p0: ref }),
          action: dt("doctor.runHealthChecks.7"),
        }));
        continue;
      }
      const writable = info.writable === false ? dt("doctor.runHealthChecks.8") : dt("doctor.runHealthChecks.9");
      const priority = source === "env" ? dt("doctor.runHealthChecks.10") : dt("doctor.runHealthChecks.11", { p0: source });
      checks.push(createCheck({
        id: `credentials:${ref}`,
        status: info.writable === false ? "warn" : "ok",
        detail: `${ref}: ${priority}, ${writable}`,
        ...(info.writable === false ? { action: dt("doctor.runHealthChecks.12") } : {}),
      }));
    }
  }

  // --- relay: /healthz, WS и переподключения -----------------------------------
  if (relay === null || typeof relay !== "object") {
    checks.push(createCheck({ id: "relay", status: "ok", detail: dt("doctor.runHealthChecks.13") }));
  } else {
    const transport = relay.transport ?? relay;
    const health = typeof transport?.healthCheck === "function"
      ? await Promise.resolve(transport.healthCheck()).catch((error) => ({ ok: false, detail: String(error?.message ?? error) }))
      : { ok: false, detail: dt("doctor.runHealthChecks.14") };
    const stats = relay.stats ?? transport?.stats ?? null;
    const ws = typeof stats?.wsState === "string" ? `WS: ${stats.wsState}` : dt("doctor.runHealthChecks.15");
    const attempts = Number.isFinite(stats?.reconnectAttempts) ? dt("doctor.runHealthChecks.16", { p0: stats.reconnectAttempts }) : "";
    const pending = Number.isFinite(transport?.pending) ? dt("doctor.runHealthChecks.17", { p0: transport.pending }) : "";
    checks.push(createCheck({
      id: "relay",
      status: health?.ok === true ? "ok" : "fail",
      detail: dt("doctor.runHealthChecks.18", { p0: relay.url ?? "relay", p1: health?.ok === true ? dt("doctor.runHealthChecks.34") : dt("doctor.runHealthChecks.35", { p0: health?.detail ?? "?" }), p2: ws, p3: attempts, p4: pending }),
      ...(health?.ok === true ? {} : { action: dt("doctor.runHealthChecks.19") }),
    }));
  }

  // --- schema state.json (032) -------------------------------------------------
  // Отказ схемы (файл из будущего, битая версия, миграция не удалась) — это fail:
  // плагин работает без удалённого режима и НЕ перезаписывает state.json.
  let schemaStatus = null;
  try {
    schemaStatus = typeof store?.schemaStatus === "function" ? store.schemaStatus() : null;
  } catch {
    schemaStatus = null;
  }
  let stateVersion = null;
  let stateReadError = null;
  try {
    const state = typeof store?.read === "function" ? store.read() : null;
    stateVersion = Number.isFinite(state?.schemaVersion)
      ? state.schemaVersion
      : Number.isFinite(state?.version)
        ? state.version
        : null;
  } catch (error) {
    stateReadError = error?.message ?? String(error);
  }
  if (schemaStatus?.error !== null && schemaStatus?.error !== undefined) {
    checks.push(createCheck({
      id: "schema",
      status: "fail",
      detail: schemaStatus.error.message,
      action: schemaStatus.error.instruction ?? dt("doctor.runHealthChecks.20"),
    }));
  } else if (supportedSchemaVersion === null) {
    checks.push(createCheck({ id: "schema", status: "ok", detail: dt("doctor.runHealthChecks.21", { p0: stateVersion ?? "?" }) }));
  } else if (stateVersion === null) {
    checks.push(createCheck({
      id: "schema",
      status: "warn",
      detail: stateReadError === null ? dt("doctor.runHealthChecks.22") : dt("doctor.runHealthChecks.23", { p0: stateReadError }),
      action: dt("doctor.runHealthChecks.24"),
    }));
  } else if (stateVersion > supportedSchemaVersion) {
    checks.push(createCheck({
      id: "schema",
      status: "fail",
      detail: dt("doctor.runHealthChecks.25", { p0: stateVersion, p1: supportedSchemaVersion }),
      action: dt("doctor.runHealthChecks.26"),
    }));
  } else {
    checks.push(createCheck({ id: "schema", status: "ok", detail: dt("doctor.runHealthChecks.27", { p0: stateVersion, p1: supportedSchemaVersion }) }));
  }

  // --- timers: повисшие TTL-таймеры (031) --------------------------------------
  if (reliability === null || typeof reliability?.healthCheck !== "function") {
    // 031 ещё не установлен: не шумим warn'ом на здоровой установке, но честно
    // пишем, что проверка пропущена.
    checks.push(createCheck({
      id: "timers",
      status: "ok",
      detail: dt("doctor.runHealthChecks.28"),
    }));
  } else {
    const health = await Promise.resolve(reliability.healthCheck()).catch((error) => ({ error }));
    if (health?.error !== undefined) {
      checks.push(createCheck({
        id: "timers",
        status: "fail",
        detail: dt("doctor.runHealthChecks.29", { p0: health.error?.message ?? health.error }),
        action: dt("doctor.runHealthChecks.30"),
      }));
    } else {
      const watching = Number.isFinite(health?.watching) ? health.watching : null;
      const pending = Number.isFinite(health?.pending) ? health.pending : null;
      const healthy = health?.ok !== false;
      checks.push(createCheck({
        id: "timers",
        status: healthy ? "ok" : "warn",
        detail: dt("doctor.runHealthChecks.31", { p0: watching ?? "?", p1: pending ?? "?" })
          + (healthy ? "" : dt("doctor.runHealthChecks.32")),
        ...(healthy ? {} : { action: dt("doctor.runHealthChecks.33") }),
      }));
    }
  }

  return checks;
}
