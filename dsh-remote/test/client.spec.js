/**
 * Тесты панели «Удалённое управление».
 *
 * Клиентская половина — классический скрипт для браузера (`window.__ModuleLoader__`),
 * поэтому её логика вынесена в `lib/panel.js` (без DOM) и тестируется здесь
 * напрямую. Сам `lib/client.js` проверяется статически: разметка таба, отсутствие
 * секретов и правильная связка с host-каналом.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TTL_MS,
  basenameOf,
  deadlineOf,
  defaultPaths,
  describeStatus,
  normalizeState,
  panelSnapshot,
  readJournalTail,
  readState,
  sanitizeText,
  sortQuestionsByDeadline,
} from "../lib/panel.js";
import {
  PanelService,
  REMOTE_METHODS_KEY,
  SHORT_ID_PATTERN,
  validateRequest,
} from "../lib/host-channel.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");

/** Временный каталог под файлы состояния и журнала. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("package.json объявляет клиентскую половину", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));

  assert.equal(pkg.exports["./client"], "./lib/client.js", "exports[./client] есть");
  assert.ok(pkg.files.includes("lib"), "lib попадает в пакет");
  assert.ok(pkg.files.includes("README.md"), "README попадает в пакет");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0, "inject непустой");
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-sidebar-right"));
});

test("client.js: обёртка ModuleLoader, таб и host-канал, без секретов", () => {
  const source = fs.readFileSync(path.join(pluginDir, "lib", "client.js"), "utf8");

  assert.match(source, /window\.__ModuleLoader__\.load\(/);
  assert.match(source, /id: "dsh-remote"/);
  assert.match(source, /sidebarRightTabs\.register\(/);
  assert.match(source, /sidebar\.right\.pane\.tab/);
  assert.match(source, /remotePanel/);
  assert.equal(/sk-[A-Za-z0-9]/.test(source), false, "в клиенте нет ключей");
  assert.equal(source.includes(os.homedir()), false, "в клиенте нет домашних путей");
  assert.equal(source.includes("__dirname"), false);
});

test("defaultPaths: окружение переопределяет пути состояния и журнала", () => {
  const custom = defaultPaths({ DSH_REMOTE_STATE: "/tmp/s.json", DSH_REMOTE_LOG: "/tmp/l.jsonl" });
  assert.deepEqual(custom, { stateFile: "/tmp/s.json", logFile: "/tmp/l.jsonl" });

  const fallback = defaultPaths({});
  assert.match(fallback.stateFile, /\.dsh\/remote-control\/state\.json$/);
  assert.match(fallback.logFile, /\.dsh\/remote-control\/log\.jsonl$/);
});

test("sanitizeText: секреты маскируются, полные пути — только basename", () => {
  const token = "123456789:AAH-bot_token-1234567890abcdefghij";
  const line = `токен ${token} путь /Users/Victor/Projects/DSHDispatcher/Worktree009 hex ABCDEF0123456789ABCDEF0123456789`;

  const safe = sanitizeText(line);
  assert.equal(safe.includes(token), false);
  assert.match(safe, /123456789:<redacted>/);
  assert.match(safe, /Worktree009/);
  assert.equal(safe.includes("/Users/Victor"), false, "полный путь спрятан");
  assert.match(safe, /<redacted-hex>/);
});

test("readJournalTail: последние строки, очищенные от секретов", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const lines = [];
  for (let index = 0; index < 30; index += 1) {
    lines.push(JSON.stringify({ time: `t${index}`, event: "delivered", shortId: `a${index}` }));
  }
  lines.push(JSON.stringify({ time: "t30", event: "error", body: "123456789:AAH-bot_token-1234567890abcdefghij" }));
  fs.writeFileSync(file, lines.join("\n"));

  const { lines: tail } = readJournalTail(file, { limit: 3 });
  assert.equal(tail.length, 3);
  assert.match(tail[2], /t30 error/, "формат «время событие»");
  assert.equal(tail.join("\n").includes("AAH-bot_token"), false, "секрет не утёк");
});

test("readJournalTail: файла нет — пусто, без исключения", () => {
  const { lines, unreadable } = readJournalTail("/nonexistent/log.jsonl");
  assert.deepEqual(lines, []);
  assert.equal(unreadable, true);
});

test("readState: битый JSON и отсутствие файла — null без исключения", (t) => {
  const dir = tempDir(t);
  const missing = readState(path.join(dir, "nope.json"));
  assert.equal(missing.state, null);
  assert.equal(missing.unreadable, true);

  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{не json");
  assert.equal(readState(broken).state, null);
});

test("normalizeState: пустое состояние не роняет панель", () => {
  const normalized = normalizeState(null);
  assert.equal(normalized.binding, null);
  assert.deepEqual(normalized.questions, []);
  assert.deepEqual(normalized.enabled, { global: false, workspaces: [], sessions: [] });
});

test("normalizeState: привязка, режим и вопросы, пути — только basename", () => {
  const normalized = normalizeState({
    bindings: { transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot", createdAt: 1000 },
    enabled: { global: false, workspaces: { "/p/dsh-dispatcher": true, "/p/other": false }, sessions: { s1: true } },
    questions: [
      { shortId: "a1b2c3d4", sessionId: "s1", taskId: "009", role: "worker", workspace: "/p/dsh-dispatcher", createdAt: 2000 },
      { shortId: "bad", sessionId: 42 },
    ],
  });

  assert.equal(normalized.binding.botUsername, "test_bot");
  assert.deepEqual(normalized.enabled.workspaces, ["dsh-dispatcher"], "выключенные и полные пути не тащим");
  assert.deepEqual(normalized.enabled.sessions, ["s1"]);
  assert.equal(normalized.questions.length, 1, "короткий shortId — отбрасываем");
  assert.deepEqual(normalized.questions.map((q) => q.shortId), ["a1b2c3d4"]);
});

test("sortQuestionsByDeadline: раньше истекающие — первыми, без дедлайна — в конце", () => {
  const now = 1_000_000;
  const questions = [
    { shortId: "cccccccc", createdAt: now },
    { shortId: "aaaaaaaa", expiresAt: now + 60_000 },
    { shortId: "bbbbbbbb", createdAt: now - 10 * 60_000 },
  ];

  const sorted = sortQuestionsByDeadline(questions, DEFAULT_TTL_MS);
  assert.deepEqual(sorted.map((question) => question.shortId), ["aaaaaaaa", "bbbbbbbb", "cccccccc"]);
  assert.ok(sorted[0].deadlineAt <= sorted[1].deadlineAt);
});

test("deadlineOf: явный expiresAt важнее расчётного", () => {
  assert.equal(deadlineOf({ expiresAt: 5, createdAt: 1 }, 1000), 5);
  assert.equal(deadlineOf({ createdAt: 1 }, 1000), 1001);
  assert.equal(deadlineOf({}, 1000), null);
});

test("describeStatus: канал, привязка и config-канал", () => {
  const state = { bindings: { transport: "telegram", botUsername: "b" }, enabled: { global: true } };
  const status = describeStatus({ state, channelPresent: true, settings: { telegram: { chatId: 42 } } });

  assert.equal(status.channel, true);
  assert.equal(status.configChannel, true);
  assert.equal(status.binding.botUsername, "b");
  assert.equal(status.enabled.global, true);

  assert.equal(describeStatus({ state: null, channelPresent: false }).channel, false);
  assert.equal(describeStatus({ state: null, channelPresent: false }).binding, null);
});

test("panelSnapshot: состояние, вопросы по дедлайну и журнал без секретов", (t) => {
  const dir = tempDir(t);
  const stateFile = path.join(dir, "state.json");
  const logFile = path.join(dir, "log.jsonl");
  const now = 1_000_000;

  fs.writeFileSync(stateFile, JSON.stringify({
    bindings: { transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" },
    enabled: { global: false, workspaces: { "/p/dsh-dispatcher": true } },
    questions: [
      { shortId: "a1b2c3d4", sessionId: "s1", taskId: "009", role: "worker", createdAt: now - 25 * 60_000 },
      { shortId: "e5f6a7b8", sessionId: "s2", createdAt: now },
    ],
  }));
  fs.writeFileSync(logFile, [
    JSON.stringify({ time: "t1", event: "delivered", shortId: "a1b2c3d4" }),
    JSON.stringify({ time: "t2", event: "error", body: "123456789:AAH-bot_token-1234567890abcdefghij" }),
  ].join("\n"));

  const snapshot = panelSnapshot({ stateFile, logFile, now: () => now, channelPresent: true });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.status.channel, true);
  assert.equal(snapshot.status.binding.botUsername, "test_bot");
  assert.deepEqual(snapshot.status.enabled.workspaces, ["dsh-dispatcher"]);
  assert.deepEqual(snapshot.questions.map((q) => q.shortId), ["a1b2c3d4", "e5f6a7b8"], "раньше истекающий — первым");
  assert.equal(snapshot.journal.lines.length, 2);
  assert.equal(JSON.stringify(snapshot).includes("AAH-bot_token"), false, "секрет не попал в снимок");
});

test("validateRequest: только пустой запрос для снимка и валидный shortId для снятия", () => {
  assert.deepEqual(validateRequest({}, []), { ok: true, value: {} });
  assert.equal(validateRequest({ path: "/etc/passwd" }, []).ok, false, "лишние поля запрещены");
  assert.equal(validateRequest({ shortId: "zzz" }, ["shortId"]).ok, false);
  assert.equal(validateRequest({ shortId: "a1b2c3d4" }, ["shortId"]).ok, true);
  assert.match("a1b2c3d4", SHORT_ID_PATTERN);
});

test("PanelService: снимок, read-only снятие и честный тест без канала", async (t) => {
  const dir = tempDir(t);
  const stateFile = path.join(dir, "state.json");
  const logFile = path.join(dir, "log.jsonl");
  fs.writeFileSync(stateFile, JSON.stringify({ questions: [{ shortId: "a1b2c3d4", createdAt: 1000 }] }));
  fs.writeFileSync(logFile, "");

  const service = new PanelService({ stateFile, logFile, settings: {}, channelPresent: false, now: () => 2000, logger: () => {} });

  const snapshot = await service.snapshot({});
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.questions.length, 1);

  const dismiss = await service.dismiss({ shortId: "a1b2c3d4" });
  assert.equal(dismiss.ok, false, "без reliability снятие честно read-only");
  assert.equal(dismiss.readonly, true);
  assert.match(dismiss.message, /\/remote status/);

  const tested = await service.test({});
  assert.equal(tested.ok, false);
  assert.match(tested.message, /канал не поднят/);

  assert.equal((await service.snapshot({ extra: 1 })).ok, false, "чужой параметр отвергнут");
});

test("PanelService: тест уходит в живой транспорт", async () => {
  const sent = [];
  const service = new PanelService({
    stateFile: "/nonexistent/state.json",
    logFile: "/nonexistent/log.jsonl",
    settings: {},
    channelPresent: true,
    now: () => 1,
    logger: () => {},
    transport: () => ({
      async sendQuestion(question) {
        sent.push(question);
      },
    }),
  });

  const tested = await service.test({});
  assert.equal(tested.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].shortId.length, 8);
});

test("PanelService: снятие через reliability, когда сервис умеет dismiss", async () => {
  let called = null;
  const service = new PanelService({
    stateFile: "/nonexistent/state.json",
    logFile: "/nonexistent/log.jsonl",
    settings: {},
    channelPresent: true,
    now: () => 1,
    logger: () => {},
    reliability: () => ({ async dismiss(request) { called = request; return true; } }),
  });

  const result = await service.dismiss({ shortId: "a1b2c3d4" });
  assert.equal(result.ok, true);
  assert.deepEqual(called, { shortId: "a1b2c3d4" });
});

test("markRemoteMethod: дескриптор remote-методов по контракту протокола", () => {
  const descriptor = Object.getOwnPropertyDescriptor(PanelService.prototype, REMOTE_METHODS_KEY)?.value;
  assert.equal(descriptor.version, 1);
  assert.deepEqual(descriptor.methods.map((entry) => entry.method).sort(), ["dismiss", "snapshot", "test"]);
  for (const entry of descriptor.methods) assert.equal(entry.invocation.kind, "direct");
});

test("basenameOf: пути с обеими косыми чертами", () => {
  assert.equal(basenameOf("/Users/Victor/Projects/dsh-dispatcher"), "dsh-dispatcher");
  assert.equal(basenameOf("C:\\projects\\dsh"), "dsh");
  assert.equal(basenameOf(""), "");
});

/**
 * Загрузить клиентский бандл в песочнице: он написан как классический скрипт
 * (`window.__ModuleLoader__.load`), но `factory` — обычная функция, поэтому её
 * можно выполнить в Node с подставным `window` и минимальным React.
 */
function loadClientInternals() {
  const source = fs.readFileSync(path.join(pluginDir, "lib", "client.js"), "utf8");
  let factory = null;
  const window = {
    __ModuleLoader__: {
      load: (spec) => {
        factory = spec.factory;
      },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function("window", source)(window);
  assert.equal(typeof factory, "function", "client.js зарегистрировал фабрику");
  const React = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
  return factory((name) => (name === "react" ? React : {}));
}

test("client: форматирование статуса, дедлайна и времени", () => {
  const client = loadClientInternals();
  const { statusLines, deadlineText, clockText } = client.__internals;

  const lines = statusLines({
    status: {
      channel: true,
      configChannel: true,
      binding: { transport: "telegram", botUsername: "test_bot" },
      enabled: { global: false, workspaces: ["dsh-dispatcher"], sessions: ["session-123456"] },
    },
  });
  assert.deepEqual(lines.map((line) => line.key), ["channel", "binding", "enabled"]);
  assert.equal(lines[1].value, "test_bot", "в статусе только имя бота");
  assert.match(lines[2].value, /dsh-dispatcher/);
  assert.match(lines[2].value, /сессия session-/);

  assert.equal(deadlineText(1_000 + 5 * 60_000, 1_000), "5 мин");
  assert.equal(deadlineText(1_000, 2_000), "истёк");
  assert.equal(deadlineText(null, 0), "—");
  assert.match(clockText(1_000), /^\d{2}:\d{2}$/);
});

test("client: RPC идёт в remotePanel и не отправляет лишнего", async () => {
  const client = loadClientInternals();
  const calls = [];
  const connection = {
    rpc: {
      async call(url, endpoint, payload, signal) {
        calls.push({ url, endpoint, payload, signal });
        return { ok: true, value: { ok: true, questions: [], journal: { lines: [] } } };
      },
    },
  };
  const face = client.__internals.createClient(connection);

  const snapshot = await face.snapshot("sig");
  assert.equal(snapshot.ok, true);
  assert.deepEqual(calls[0], {
    url: "/api",
    endpoint: "remotePanel/snapshot",
    payload: { args: { request: {} } },
    signal: "sig",
  });

  await face.dismiss("a1b2c3d4");
  assert.deepEqual(calls[1].payload, { args: { request: { shortId: "a1b2c3d4" } } });

  await face.test();
  assert.equal(calls[2].endpoint, "remotePanel/test");

  const offline = client.__internals.createClient(null);
  assert.deepEqual(await offline.snapshot(), { ok: false, offline: true, message: "" });
});

test("client: inject содержит sidebarRightTabs (иначе таб не зарегистрируется)", () => {
  const client = loadClientInternals();
  assert.deepEqual(client.inject, ["slots", "locale", "sidebarRightTabs", "connection"]);
});

test("channelPresent вычисляется в момент снимка: канал появился и исчез", async (t) => {
  const dir = tempDir(t);
  const stateFile = path.join(dir, "state.json");
  const logFile = path.join(dir, "log.jsonl");
  fs.writeFileSync(stateFile, JSON.stringify({ bindings: null }));
  fs.writeFileSync(logFile, "");

  let up = false;
  const service = new PanelService({
    stateFile,
    logFile,
    settings: {},
    channelPresent: () => up,
    now: () => 1,
    logger: () => {},
  });

  assert.equal((await service.snapshot({})).status.channel, false, "канала ещё нет");
  up = true;
  assert.equal((await service.snapshot({})).status.channel, true, "канал появился после connect");
  up = false;
  assert.equal((await service.snapshot({})).status.channel, false, "канал остановлен");
});

test("normalizeState сохраняет expiresAt, дедлайн и сортировка его учитывают", () => {
  const now = 1_000_000;
  const normalized = normalizeState({
    questions: [
      { shortId: "aaaaaaaa", createdAt: now, expiresAt: now + 60_000 },
      { shortId: "bbbbbbbb", createdAt: now - 10 * 60_000 },
    ],
  });

  assert.equal(normalized.questions[0].expiresAt, now + 60_000, "кастомный TTL не теряется");
  assert.equal(deadlineOf(normalized.questions[0]), now + 60_000);
  assert.deepEqual(sortQuestionsByDeadline(normalized.questions).map((q) => q.shortId), ["aaaaaaaa", "bbbbbbbb"]);
});

test("PanelService.test: клик по кнопке закрывает тестовое сообщение", async () => {
  const sent = [];
  const closed = [];
  let handler = null;
  let offCalls = 0;
  const transport = {
    async sendQuestion(question) {
      sent.push(question);
      return { messageId: 1 };
    },
    async closeQuestion(question, summary) {
      closed.push({ question, summary });
    },
    onAnswer(callback) {
      handler = callback;
      return () => {
        offCalls += 1;
      };
    },
  };
  const service = new PanelService({
    stateFile: "/nonexistent/state.json",
    logFile: "/nonexistent/log.jsonl",
    settings: {},
    channelPresent: true,
    now: () => 1_000,
    logger: () => {},
    transport: () => transport,
  });

  const tested = await service.test({});
  assert.equal(tested.ok, true);
  assert.equal(sent.length, 1);

  handler({ shortId: sent[0].shortId, optionIds: ["ok"] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closed.length, 1, "ответ закрывает сообщение");
  assert.equal(closed[0].summary, "тест пройден");
  assert.equal(offCalls, 1, "подписка снята");
});

test("PanelService.test: без клика подписка снимается по таймауту", async () => {
  let offCalls = 0;
  let timerCallback = null;
  const transport = {
    async sendQuestion() {
      return { messageId: 1 };
    },
    async closeQuestion() {},
    onAnswer() {
      return () => {
        offCalls += 1;
      };
    },
  };
  const service = new PanelService({
    stateFile: "/nonexistent/state.json",
    logFile: "/nonexistent/log.jsonl",
    settings: {},
    channelPresent: true,
    now: () => 1,
    logger: () => {},
    transport: () => transport,
    testAnswerTimeoutMs: 1000,
    setTimeoutImpl: (callback) => {
      timerCallback = callback;
      return { unref: () => {} };
    },
  });

  await service.test({});
  assert.equal(offCalls, 0, "до таймаута подписка жива");
  timerCallback();
  assert.equal(offCalls, 1, "таймаут снял подписку");
});
