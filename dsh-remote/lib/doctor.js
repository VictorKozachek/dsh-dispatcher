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

/** Статусы проверок в порядке возрастания серьёзности. */
export const DOCTOR_STATUS = Object.freeze(["ok", "warn", "fail"]);

/** Код возврата для скриптов: 0 — ok, 1 — warn, 2 — fail. */
export const EXIT_CODES = Object.freeze({ ok: 0, warn: 1, fail: 2 });

/**
 * Одна проверка. Поля фиксированы: `id` (машинный), `status`, `detail`, `action`
 * (что делать; обязателен для `fail`).
 */
export function createCheck({ id, status = "ok", detail = "", action = undefined } = {}) {
  if (typeof id !== "string" || id === "") throw new TypeError("doctor: у проверки нет id");
  if (!DOCTOR_STATUS.includes(status)) throw new TypeError(`doctor: неизвестный статус ${status}`);
  if (status === "fail" && (typeof action !== "string" || action === "")) {
    throw new TypeError(`doctor: fail-проверка ${id} без action`);
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
export function formatHealthReport(report) {
  const lines = report.checks.map((check) => {
    const head = `[${check.status}] ${check.id}: ${check.detail}`;
    return check.action === undefined ? head : `${head}\n      → ${check.action}`;
  });
  const failed = report.checks.filter((check) => check.status === "fail").length;
  const warned = report.checks.filter((check) => check.status === "warn").length;
  const summary = failed > 0
    ? `есть проблемы: ${failed} fail, ${warned} warn — сделайте шаги из подсказок`
    : warned > 0
      ? `работает, но есть предупреждения: ${warned}`
      : "всё в порядке";
  return [...lines, "", lastLine(summary, report.exitCode)].join("\n");
}

function lastLine(summary, exitCode) {
  return `${summary} (код ${exitCode})`;
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
    action: check.hint ?? (check.level === "fail" ? "проверьте пункт вручную: /remote doctor" : undefined),
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
} = {}) {
  const checks = [...fromLegacyChecks(legacyChecks)];

  // --- credentials: ссылки, источник, writable ---------------------------------
  const refs = (Array.isArray(tokenRefs) ? tokenRefs : []).filter((ref) => typeof ref === "string" && ref !== "");
  if (credentials === null || typeof credentials?.describe !== "function") {
    checks.push(createCheck({
      id: "credentials",
      status: "warn",
      detail: "ctx.credentials недоступен",
      action: "проверьте установку плагина: bin/install-remote.sh",
    }));
  } else if (refs.length === 0) {
    checks.push(createCheck({ id: "credentials", status: "ok", detail: "ссылки на секреты не настроены" }));
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
          detail: `${ref}: describe() не ответил`,
          action: "проверьте секрет вручную: /remote connect",
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
          detail: `${ref}: секрет не найден`,
          action: "задайте секрет: /remote connect (или переменную окружения)",
        }));
        continue;
      }
      const writable = info.writable === false ? "только чтение" : "запись доступна";
      const priority = source === "env" ? "приоритет env: переменная окружения перекрывает файл" : `источник: ${source}`;
      checks.push(createCheck({
        id: `credentials:${ref}`,
        status: info.writable === false ? "warn" : "ok",
        detail: `${ref}: ${priority}, ${writable}`,
        ...(info.writable === false ? { action: "секрет только для чтения — обновите его вручную или через /remote connect" } : {}),
      }));
    }
  }

  // --- relay: /healthz, WS и переподключения -----------------------------------
  if (relay === null || typeof relay !== "object") {
    checks.push(createCheck({ id: "relay", status: "ok", detail: "релей не настроен (каналы мессенджеров)" }));
  } else {
    const transport = relay.transport ?? relay;
    const health = typeof transport?.healthCheck === "function"
      ? await Promise.resolve(transport.healthCheck()).catch((error) => ({ ok: false, detail: String(error?.message ?? error) }))
      : { ok: false, detail: "healthCheck недоступен" };
    const stats = relay.stats ?? transport?.stats ?? null;
    const ws = typeof stats?.wsState === "string" ? `WS: ${stats.wsState}` : "WS: неизвестно";
    const attempts = Number.isFinite(stats?.reconnectAttempts) ? `, переподключений: ${stats.reconnectAttempts}` : "";
    const pending = Number.isFinite(transport?.pending) ? `, ждёт ответа: ${transport.pending}` : "";
    checks.push(createCheck({
      id: "relay",
      status: health?.ok === true ? "ok" : "fail",
      detail: `${relay.url ?? "relay"}: ${health?.ok === true ? "на связи" : `нет связи (${health?.detail ?? "?"})`}; ${ws}${attempts}${pending}`,
      ...(health?.ok === true ? {} : { action: "проверьте URL/токен и /healthz релея: /remote doctor" }),
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
      action: schemaStatus.error.instruction ?? "восстановите state.json из state.json.bak-* или обновите плагин",
    }));
  } else if (supportedSchemaVersion === null) {
    checks.push(createCheck({ id: "schema", status: "ok", detail: `версия схемы не проверяется (state: ${stateVersion ?? "?"})` }));
  } else if (stateVersion === null) {
    checks.push(createCheck({
      id: "schema",
      status: "warn",
      detail: stateReadError === null ? "версия схемы state.json не прочитана" : `state.json не прочитан: ${stateReadError}`,
      action: "проверьте state.json: /remote connect",
    }));
  } else if (stateVersion > supportedSchemaVersion) {
    checks.push(createCheck({
      id: "schema",
      status: "fail",
      detail: `state.json версии ${stateVersion} новее плагина (${supportedSchemaVersion})`,
      action: "обновите плагин dsh-remote или восстановите state.json из state.json.bak-*",
    }));
  } else {
    checks.push(createCheck({ id: "schema", status: "ok", detail: `state.json версии ${stateVersion} (поддерживается ${supportedSchemaVersion})` }));
  }

  // --- timers: повисшие TTL-таймеры (031) --------------------------------------
  if (reliability === null || typeof reliability?.healthCheck !== "function") {
    // 031 ещё не установлен: не шумим warn'ом на здоровой установке, но честно
    // пишем, что проверка пропущена.
    checks.push(createCheck({
      id: "timers",
      status: "ok",
      detail: "пропущено: счётчики TTL-таймеров (031) не установлены",
    }));
  } else {
    const health = await Promise.resolve(reliability.healthCheck()).catch((error) => ({ error }));
    if (health?.error !== undefined) {
      checks.push(createCheck({
        id: "timers",
        status: "fail",
        detail: `healthCheck устойчивости упал: ${health.error?.message ?? health.error}`,
        action: "проверьте журнал плагина и state.json; перезапустите профиль",
      }));
    } else {
      const watching = Number.isFinite(health?.watching) ? health.watching : null;
      const pending = Number.isFinite(health?.pending) ? health.pending : null;
      const healthy = health?.ok !== false;
      checks.push(createCheck({
        id: "timers",
        status: healthy ? "ok" : "warn",
        detail: `TTL: активных ${watching ?? "?"}, в pending ${pending ?? "?"}`
          + (healthy ? "" : "; канал устойчивости не в порядке"),
        ...(healthy ? {} : { action: "проверьте канал и журнал: /remote status" }),
      }));
    }
  }

  return checks;
}
