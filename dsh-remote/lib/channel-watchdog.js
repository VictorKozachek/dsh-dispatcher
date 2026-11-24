/**
 * 086: сторож канала.
 *
 * Поллер может «зависнуть»: сеть, 429, смена токена, тихая ошибка цикла. Тогда
 * вопросы перестают приходить, а `/remote status` всё ещё говорит «канал поднят».
 * Сторож смотрит на два независимых сигнала — давно не было ни апдейтов, ни
 * успешных запросов (тишина) и серия ошибок поллинга — и перезапускает транспорт.
 *
 * Состояние в памяти: после рестарта процесса его не нужно восстанавливать,
 * сторож начинает отсчёт заново. Перезапуск не делается, пока канал занят
 * доставкой вопроса (`isBusy`), и после `maxRestarts` неудач канал помечается
 * failed — бесконечных попыток нет.
 */

export const CHANNEL_WATCHDOG_DEFAULTS = Object.freeze({
  silenceMs: 10 * 60 * 1000,
  errorLimit: 5,
  maxRestarts: 3,
});

export function createChannelWatchdog({
  transport = null,
  now = () => Date.now(),
  silenceMs = CHANNEL_WATCHDOG_DEFAULTS.silenceMs,
  errorLimit = CHANNEL_WATCHDOG_DEFAULTS.errorLimit,
  maxRestarts = CHANNEL_WATCHDOG_DEFAULTS.maxRestarts,
  isBusy = () => false,
  onEvent = () => {},
  log = () => {},
  setInterval: setIntervalImpl = globalThis.setInterval,
  clearInterval: clearIntervalImpl = globalThis.clearInterval,
  intervalMs = 60_000,
  autostart = true,
} = {}) {
  if (typeof now !== "function") throw new TypeError("channel-watchdog: now ждёт функцию");
  if (!Number.isFinite(silenceMs) || silenceMs <= 0) throw new TypeError("channel-watchdog: silenceMs > 0");
  if (!Number.isInteger(errorLimit) || errorLimit < 1) throw new TypeError("channel-watchdog: errorLimit >= 1");
  if (!Number.isInteger(maxRestarts) || maxRestarts < 1) throw new TypeError("channel-watchdog: maxRestarts >= 1");

  const startedAt = now();
  let lastUpdateAt = null;
  let lastPollOkAt = startedAt;
  let consecutiveErrors = 0;
  let restarts = 0;
  let failed = false;
  let lastError = null;
  let lastRestartAt = null;
  let timer = null;
  let restarting = false;

  function emit(event, detail = {}) {
    try {
      onEvent({ event, at: now(), ...detail });
    } catch (error) {
      log(`сторож канала: журнал упал (${error?.message ?? error})`);
    }
  }

  function noteUpdate(at = now()) {
    lastUpdateAt = at;
    lastPollOkAt = at;
    consecutiveErrors = 0;
    if (failed) {
      failed = false;
      emit("channel.recovered");
    }
  }

  function notePollOk(at = now()) {
    lastPollOkAt = at;
    consecutiveErrors = 0;
    if (failed) {
      failed = false;
      emit("channel.recovered");
    }
  }

  function noteError(error, at = now()) {
    lastError = error?.message ?? String(error ?? "unknown");
    consecutiveErrors += 1;
    if (consecutiveErrors >= errorLimit && !failed) {
      return requestRestart("errors", { at });
    }
    return null;
  }

  function silentMinutes(at = now()) {
    return Math.floor((at - lastPollOkAt) / 60_000);
  }

  function isSilent(at = now()) {
    return at - lastPollOkAt >= silenceMs;
  }

  async function restart(reason, detail = {}) {
    if (failed || restarting) return "skipped";
    if (typeof transport?.stop !== "function" || typeof transport?.start !== "function") {
      failed = true;
      emit("channel.failed", { reason, lastError: lastError ?? "нет stop/start", restarts });
      return "failed";
    }
    if (isBusy()) return "busy";
    restarting = true;
    try {
      await transport.stop();
      await transport.start();
      restarts += 1;
      lastRestartAt = now();
      consecutiveErrors = 0;
      lastPollOkAt = lastRestartAt;
      emit("channel.restart", { attempt: restarts, reason, lastError, ...detail });
      return "restarted";
    } catch (error) {
      restarts += 1;
      lastError = error?.message ?? String(error);
      emit("channel.restart", { attempt: restarts, reason, lastError, failed: true, ...detail });
      if (restarts >= maxRestarts) {
        failed = true;
        emit("channel.failed", { reason, lastError, restarts });
        return "failed";
      }
      return "error";
    } finally {
      restarting = false;
    }
  }

  function requestRestart(reason, detail = {}) {
    if (failed) return Promise.resolve("skipped");
    return restart(reason, detail);
  }

  async function tick(at = now()) {
    if (failed) return "failed";
    if (isBusy()) return "busy";
    if (isSilent(at)) {
      emit("channel.stall", { silentMinutes: silentMinutes(at) });
      return restart("silence", { silentMinutes: silentMinutes(at) });
    }
    if (consecutiveErrors >= errorLimit) {
      emit("channel.stall", { errors: consecutiveErrors });
      return restart("errors", { errors: consecutiveErrors });
    }
    return "ok";
  }

  function status(at = now()) {
    return {
      startedAt,
      lastUpdateAt,
      lastUpdateMinutes: lastUpdateAt === null ? null : Math.floor((at - lastUpdateAt) / 60_000),
      lastPollOkAt,
      silentMinutes: silentMinutes(at),
      restarts,
      lastRestartAt,
      lastError,
      consecutiveErrors,
      failed,
    };
  }

  function start() {
    if (timer !== null) return;
    timer = setIntervalImpl(() => { void tick(); }, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    if (timer === null) return;
    clearIntervalImpl(timer);
    timer = null;
  }

  if (autostart) start();

  return { noteUpdate, notePollOk, noteError, tick, restart, status, start, stop, isSilent };
}
