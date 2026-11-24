import test from "node:test";
import assert from "node:assert/strict";

import { createChannelWatchdog } from "../lib/channel-watchdog.js";

function clock(start = 0) {
  return { now: () => start, advance: (ms) => { start += ms; } };
}
function fakeTransport({ failStart = false } = {}) {
  const calls = [];
  return {
    id: "fake",
    calls,
    async stop() { calls.push("stop"); },
    async start() { calls.push("start"); if (failStart) throw new Error("start failed"); },
  };
}
function setup(overrides = {}) {
  const time = clock();
  const transport = fakeTransport();
  const events = [];
  const watchdog = createChannelWatchdog({
    transport,
    now: time.now,
    autostart: false,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { time, transport, events, watchdog };
}

test("086: тишина в апдейтах перезапускает транспорт и пишет channel.stall", async () => {
  const { time, transport, events, watchdog } = setup({ silenceMs: 10 * 60 * 1000 });
  time.advance(9 * 60 * 1000);
  assert.equal(await watchdog.tick(), "ok", "девять минут — ещё не тишина");
  time.advance(61 * 1000);
  assert.equal(await watchdog.tick(), "restarted");
  assert.deepEqual(transport.calls, ["stop", "start"]);
  assert.equal(events.some((e) => e.event === "channel.stall"), true);
  assert.equal(events.some((e) => e.event === "channel.restart" && e.attempt === 1), true);
});

test("086: серия ошибок перезапускает, успешный апдейт сбрасывает счётчики", async () => {
  const { transport, events, watchdog } = setup({ errorLimit: 3 });
  for (let index = 0; index < 2; index += 1) assert.equal(watchdog.noteError(new Error("429")), null);
  assert.equal(await watchdog.noteError(new Error("429")), "restarted");
  assert.deepEqual(transport.calls, ["stop", "start"]);
  assert.equal(watchdog.status().consecutiveErrors, 0);
  assert.equal(events.filter((e) => e.event === "channel.restart").length, 1);
  watchdog.noteUpdate();
  assert.equal(watchdog.status().lastUpdateMinutes, 0);
});

test("086: после трёх неудачных перезапусков канал failed и status честный", async () => {
  const time = clock();
  const transport = fakeTransport({ failStart: true });
  const events = [];
  const watchdog = createChannelWatchdog({ transport, now: time.now, autostart: false, errorLimit: 1, maxRestarts: 3, silenceMs: 10 * 60 * 1000, onEvent: (e) => events.push(e) });
  time.advance(11 * 60 * 1000);
  assert.equal(await watchdog.tick(), "error");
  assert.equal(watchdog.status().restarts, 1);
  assert.equal(await watchdog.tick(), "error");
  assert.equal(await watchdog.tick(), "failed");
  assert.equal(watchdog.status().failed, true);
  assert.equal(watchdog.status().lastError, "start failed");
  assert.equal(events.filter((e) => e.event === "channel.failed").length, 1);
  assert.equal(await watchdog.tick(), "failed", "бесконечных попыток нет");
});

test("086: при pending/доставке перезапуск откладывается", async () => {
  const { time, transport, watchdog } = setup({ silenceMs: 10 * 60 * 1000, isBusy: () => true });
  time.advance(11 * 60 * 1000);
  assert.equal(await watchdog.tick(), "busy");
  assert.deepEqual(transport.calls, [], "во время доставки канал не трогаем");
});

test("086: статус показывает последний апдейт, перезапуски и ошибку", async () => {
  const { time, watchdog } = setup({ errorLimit: 5 });
  time.advance(3 * 60 * 1000);
  watchdog.noteUpdate();
  watchdog.noteError(new Error("502 bad gateway"));
  const status = watchdog.status();
  assert.equal(status.lastUpdateMinutes, 0);
  assert.equal(status.restarts, 0);
  assert.equal(status.lastError, "502 bad gateway");
  assert.equal(status.consecutiveErrors, 1);
  assert.equal(status.failed, false);
});

test("086: после failed и успешного апдейта пишется channel.recovered", async () => {
  const time = clock();
  const transport = fakeTransport({ failStart: true });
  const events = [];
  const watchdog = createChannelWatchdog({
    transport, now: time.now, autostart: false, errorLimit: 1, maxRestarts: 1, silenceMs: 10 * 60 * 1000, onEvent: (e) => events.push(e),
  });
  time.advance(11 * 60 * 1000);
  await watchdog.tick();
  assert.equal(watchdog.status().failed, true);
  watchdog.noteUpdate();
  assert.equal(watchdog.status().failed, false);
  assert.equal(events.some((e) => e.event === "channel.recovered"), true);
});

test("086: неудачные перезапуски идут с backoff, а не сразу", async () => {
  const time = clock();
  const transport = fakeTransport({ failStart: true });
  const delays = [];
  const watchdog = createChannelWatchdog({
    transport,
    now: time.now,
    autostart: false,
    silenceMs: 10 * 60 * 1000,
    maxRestarts: 3,
    sleep: async (ms) => { delays.push(ms); },
  });
  time.advance(11 * 60 * 1000);
  assert.equal(await watchdog.tick(), "error");
  assert.deepEqual(delays, [1_000]);
  assert.equal(await watchdog.tick(), "error");
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.equal(await watchdog.tick(), "failed");
  assert.equal(watchdog.status().restarts, 3);
});

test("086 feature: pending из remoteReliability откладывает перезапуск", async () => {
  const { channelWatchdogFeature, CHANNEL_WATCHDOG_SERVICE } = await import("../lib/features/channel-watchdog.js");
  let clockValue = 0;
  const transport = fakeTransport();
  const services = new Map([["remoteTransport", transport], ["remoteReliability", { pendingList: () => [{ shortId: "x" }] }]]);
  const provided = new Map();
  const ctx = { provide: (name, value) => provided.set(name, value), get: (name) => services.get(name) ?? null };
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services.get(name) ?? null,
    onDispose: (fn) => { services.set("dispose", fn); },
  };
  await channelWatchdogFeature.apply(ctx, { channel: { silenceMinutes: 1 } }, deps);
  const watchdog = provided.get(CHANNEL_WATCHDOG_SERVICE);
  assert.ok(watchdog);
  // Подменяем часы сторожу нельзя (он создан с Date.now), поэтому проверяем
  // статус и busy через публичный isBusy-эффект: pending непуст → tick busy.
  assert.equal(await watchdog.tick(clockValue + 120_000), "busy");
  assert.deepEqual(transport.calls, [], "pending не даёт перезапустить канал");
});

test("086 feature: активная отправка (isSending) откладывает перезапуск", async () => {
  const { channelWatchdogFeature, CHANNEL_WATCHDOG_SERVICE } = await import("../lib/features/channel-watchdog.js");
  const transport = fakeTransport();
  const services = new Map([
    ["remoteTransport", transport],
    ["remoteReliability", { pendingList: () => [], isSending: () => true }],
  ]);
  const provided = new Map();
  const ctx = { provide: (name, value) => provided.set(name, value), get: (name) => services.get(name) ?? null };
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services.get(name) ?? null,
    onDispose: () => {},
  };
  await channelWatchdogFeature.apply(ctx, { channel: { silenceMinutes: 1 } }, deps);
  const watchdog = provided.get(CHANNEL_WATCHDOG_SERVICE);
  assert.equal(await watchdog.tick(Date.now() + 120_000), "busy");
  assert.deepEqual(transport.calls, []);
});
