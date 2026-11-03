/**
 * Фича «метрики» (031): создаёт набор счётчиков и публикует `remoteMetrics`.
 *
 * Идёт первой в списке фич: остальные (answerer/approvals/broker) читают сервис
 * через `deps.get("remoteMetrics")` и инкрементят его. Только числа — ни тел
 * вопросов, ни идентификаторов людей.
 */

import { createMetrics } from "../metrics.js";

export const METRICS_SERVICE = "remoteMetrics";

export const metricsFeature = {
  name: "metrics",
  needs: [],
  apply(ctx, config, deps) {
    const metrics = createMetrics({ log: (message) => deps.logger.debug(message) });
    try {
      ctx.provide?.(METRICS_SERVICE, metrics);
    } catch (error) {
      deps.logger.warn(`метрики: сервис ${METRICS_SERVICE} не зарегистрирован (${error?.message ?? error})`);
      return;
    }
    deps.logger.debug("метрики: remoteMetrics опубликован");
    void config;
  },
};
