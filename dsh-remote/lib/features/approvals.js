/**
 * Фича «подтверждения»: `approval/request` уходит человеку в канал.
 *
 * Подключается одной строкой в `lib/features.js`. Режим — тот же, что у вопросов
 * (`state.enabled` через `remoteStore`): выключен — подтверждение рисует GUI,
 * поведение DSH не меняется. Явный выключатель `config.approvals.enabled: false`
 * снимает фичу целиком (полезно, когда удалённо подтверждать действия запрещено
 * политикой).
 *
 * Политика (таймаут=отказ, allowlist инструментов, `denyRemote`) — задача 025;
 * аудит — 026; очередь и роутинг — 027; гибрид с GUI — 028. Здесь только ответчик:
 * три кнопки, закрытый словарь исходов и честный `next()` при выключенном режиме.
 */

import { DEFAULT_HYBRID_WAIT_MS, createApprovals } from "../approvals.js";
import { createApprovalPolicy } from "../approvals/policy.js";
import { createAudit } from "../audit.js";
import { createRegistry } from "../domain/registry.js";
import { resolveChannel } from "../store.js";

/** Имя сервиса транспорта (объявляет фича telegram/relay). */
export const TRANSPORT_SERVICE = "remoteTransport";

/** Имя сервиса состояния (объявляет фича commands). */
export const STATE_SERVICE = "remoteStore";

/** Имя сервиса подтверждений: статистика решений для `/remote status` (026). */
export const APPROVALS_SERVICE = "remoteApprovals";

/**
 * Гибридный конфиг подтверждений (028) из строки плагина.
 *
 * По умолчанию выключен: пока человек не написал `approvals.hybrid: true`,
 * поведение ровно как в 024 (ждём ответ сколько угодно).
 */
export function hybridConfigFrom(config) {
  const settings = config?.approvals ?? {};
  const waitMs = Number.isFinite(settings.hybridWaitMs) && settings.hybridWaitMs > 0
    ? Math.floor(settings.hybridWaitMs)
    : DEFAULT_HYBRID_WAIT_MS;
  return { enabled: settings.hybrid === true, waitMs };
}

export const approvalsFeature = {
  name: "approvals",
  needs: [TRANSPORT_SERVICE],
  apply(ctx, config, deps) {
    if (config?.approvals?.enabled === false) {
      deps.logger.debug("фича approvals: выключена конфигом — подтверждения остаются в GUI");
      return;
    }

    const store = deps.get(STATE_SERVICE);
    const registry = createRegistry({
      readState: () => {
        try {
          const state = typeof store?.read === "function" ? store.read() : null;
          return state?.enabled ?? {};
        } catch (error) {
          deps.logger.warn(`approvals: состояние не прочитано (${error?.message ?? error})`);
          return {};
        }
      },
      log: (message) => deps.logger.debug(message),
    });

    // Несколько каналов (012-подобная гонка): список из config.transports, сами
    // транспорты — из реестра; один канал — прежний путь через фасад.
    const requested = Array.isArray(config?.transports) ? config.transports.filter((id) => typeof id === "string") : null;
    const transportRegistry = deps.get("remoteTransports");
    let transports = null;
    if (requested !== null && requested.length > 1 && transportRegistry !== null) {
      const missing = requested.filter((id) => transportRegistry.get(id) === undefined);
      if (missing.length > 0) {
        deps.logger.warn(`approvals: каналы из config.transports не найдены: ${missing.join(", ")} — работаю с тем, что есть`);
      }
      transports = requested.map((id) => transportRegistry.get(id) ?? null).filter((item) => item !== null);
      if (transports.length <= 1) transports = null;
    }

    // 025: политика по умолчанию — безопасная (allowlist, denyRemote,
    // таймаут = отказ); конфиг может только сузить права, но не расширить
    // их молча.
    const policy = createApprovalPolicy(config?.approvals, {
      log: (message) => deps.logger.warn(message),
    });
    deps.logger.debug(`approvals: ${policy.describe().join("; ")}`);

    // Аудит решений (026): `audit.jsonl` рядом с state.json; путь можно
    // переопределить через DSH_REMOTE_AUDIT (тесты). Решения 025 (policy-GUI и
    // TTL-таймаут) пишутся в тот же журнал через `audit` ниже.
    const audit = createAudit({
      ...(typeof store?.paths?.dir === "string" && store.paths.dir !== "" ? { dir: store.paths.dir } : {}),
      log: (message) => deps.logger.debug(message),
    });

    // Гибрид (028): не ответили `hybridWaitMs` — подтверждение уходит в GUI.
    const hybrid = hybridConfigFrom(config);

    const approvals = createApprovals({
      transport: deps.get(TRANSPORT_SERVICE),
      transports,
      registry,
      audit,
      hybrid,
      metrics: deps.get("remoteMetrics") ?? null,
      // 015: канал проекта — свой чат/топик, иначе общий чат привязки.
      channelOf: (workspace, transportId) => resolveChannel(store?.read?.() ?? {}, workspace, transportId),
      policy,
      ttlMs: policy.ttlMs,
      onTimeout: () => policy.timeoutOutcome(),
      log: (message) => deps.logger.debug(message),
    });

    deps.onDispose(approvals.attach(ctx));

    try {
      ctx.provide?.(APPROVALS_SERVICE, {
        stats: approvals.stats,
        policy,
        get pendingOpen() {
          return approvals.pending?.size ?? 0;
        },
      });
      // Для `/remote status` (025): действующая политика.
      ctx.provide?.("remoteApprovalPolicy", policy);
    } catch (error) {
      deps.logger.debug(`approvals: сервис статистики не зарегистрирован (${error?.message ?? error})`);
    }
  },
};
