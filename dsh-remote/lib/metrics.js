/**
 * Метрики плагина (задача 031).
 *
 * Только числа: ни тел вопросов, ни id пользователей, ни токенов. Счётчики и
 * гистограммы живут в памяти процесса (сброс при старте плагина) и публикуются
 * как сервис `remoteMetrics` для `/remote stats`, панели (009) и doctor (030).
 *
 * Гистограммы — с фиксированными бакетами: память не растёт с числом наблюдений.
 */

/** Границы бакетов латентности, мс. */
export const LATENCY_BUCKETS_MS = Object.freeze([100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 300_000]);

/** Известные транспорты для счётчиков ошибок; остальные уходят в `other`. */
const KNOWN_TRANSPORTS = Object.freeze(["telegram", "max", "relay", "fake"]);

const noopLog = () => {};

/** Пустые счётчики: структура фиксирована, чтобы JSON был стабилен. */
export function emptySnapshot() {
  return {
    questions: { asked: 0, answered: 0, expired: 0, cancelled: 0 },
    approvals: {
      allowed_once: 0,
      rejected: 0,
      unavailable: 0,
      cancelled: 0,
      policy_gui: 0,
      timeout: 0,
      late: 0,
    },
    deliveries: { sent: 0, failed: 0, retried: 0 },
    errors: {},
    /** Размеры очередей: выставляются сервисами через `gauge()`. */
    queues: { deliveries_pending: 0, timers_active: 0, approvals_open: 0 },
    latency: { count: 0, sumMs: 0, buckets: LATENCY_BUCKETS_MS.map((le) => ({ le, count: 0 })) },
  };
}

/**
 * Создать набор метрик.
 *
 * API намеренно маленький: `inc(name, delta)`, `observeLatency(ms)`,
 * `transportError(id)`, `snapshot()`. Неизвестное имя счётчика — ошибка
 * программиста (ловится тестами), а не молчаливая потеря данных.
 */
export function createMetrics({ now = () => Date.now(), log = noopLog } = {}) {
  const data = emptySnapshot();
  const startedAt = now();

  /** Разрешённые счётчики: путь `раздел.поле`. */
  const paths = new Map();
  for (const [section, values] of Object.entries(data)) {
    if (section === "latency" || section === "errors") continue;
    for (const key of Object.keys(values)) paths.set(`${section}.${key}`, [section, key]);
  }

  function inc(name, delta = 1) {
    const path = paths.get(name);
    if (path === undefined) throw new RangeError(`metrics: неизвестный счётчик ${name}`);
    const step = Number(delta);
    if (!Number.isFinite(step)) throw new TypeError(`metrics: ${name}: delta должен быть числом`);
    if (step < 0) throw new RangeError(`metrics: ${name}: delta не может быть отрицательным`);
    const [section, key] = path;
    data[section][key] += step;
    return data[section][key];
  }

  /** Наблюдение латентности: попадает ровно в один бакет (или в последний). */
  function observeLatency(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return false;
    data.latency.count += 1;
    data.latency.sumMs += value;
    let placed = false;
    for (const bucket of data.latency.buckets) {
      if (!placed && value <= bucket.le) {
        bucket.count += 1;
        placed = true;
      }
    }
    if (!placed) data.latency.buckets[data.latency.buckets.length - 1].count += 1;
    return true;
  }

  /** Размер очереди: целое ≥ 0, фиксированные имена. */
  function gauge(name, value) {
    if (!(name in data.queues)) throw new RangeError(`metrics: неизвестная очередь ${name}`);
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new TypeError(`metrics: ${name}: значение ≥ 0`);
    data.queues[name] = Math.floor(number);
  }

  /** Ошибка транспорта: id нормализуется до известных, иначе `other`. */
  function transportError(transportId) {
    const key = KNOWN_TRANSPORTS.includes(transportId) ? transportId : "other";
    data.errors[key] = (data.errors[key] ?? 0) + 1;
    return data.errors[key];
  }

  /** Снимок для `/remote stats` и `--json`: только числа, фиксированные ключи. */
  function snapshot() {
    return {
      questions: { ...data.questions },
      approvals: { ...data.approvals },
      deliveries: { ...data.deliveries },
      errors: { ...data.errors },
      queues: { ...data.queues },
      latency: {
        count: data.latency.count,
        sumMs: data.latency.sumMs,
        buckets: data.latency.buckets.map((bucket) => ({ ...bucket })),
      },
      uptimeMs: Math.max(0, now() - startedAt),
    };
  }

  return { inc, observeLatency, transportError, gauge, snapshot, startedAt };
}

/** Человеческий вывод `/remote stats`: короткие строки, без секретов. */
export function formatStats(snapshot) {
  const q = snapshot.questions;
  const a = snapshot.approvals;
  const d = snapshot.deliveries;
  const latency = snapshot.latency;
  const avg = latency.count > 0 ? Math.round(latency.sumMs / latency.count) : 0;
  const lines = [
    `вопросы: задано ${q.asked}, отвечено ${q.answered}, истекло ${q.expired}, отменено ${q.cancelled}`,
    `подтверждения: allowed-once ${a.allowed_once}, отклонено ${a.rejected}, unavailable ${a.unavailable}, cancelled ${a.cancelled}`,
    `подтверждения: policy-GUI ${a.policy_gui}, таймаут ${a.timeout}, поздних ${a.late}`,
    `доставки: отправлено ${d.sent}, ошибок ${d.failed}, повторов ${d.retried}`,
    `очереди: доставок ${snapshot.queues.deliveries_pending}, таймеров ${snapshot.queues.timers_active}, подтверждений ${snapshot.queues.approvals_open}`,
    `латентность ответа: наблюдений ${latency.count}, среднее ${avg} мс`,
    `uptime: ${Math.round(snapshot.uptimeMs / 1000)} с`,
  ];
  const errors = Object.entries(snapshot.errors ?? {});
  if (errors.length > 0) lines.push(`ошибки транспортов: ${errors.map(([id, count]) => `${id}=${count}`).join(", ")}`);
  return lines.join("\n");
}

/** Гистограмма в виде `{le, count}` — для JSON и панели. */
export function latencyBuckets(snapshot) {
  return snapshot.latency.buckets.map((bucket) => ({ le: bucket.le, count: bucket.count }));
}
