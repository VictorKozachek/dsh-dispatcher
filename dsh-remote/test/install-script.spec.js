/**
 * Тесты установщика `bin/install-remote.sh`.
 *
 * Скрипт в живой профиль не запускаем: только `bash -n`, `--help`, отказ при
 * двойном ряде и `--dry-run`. `--dry-run` обязан печатать план и **ничего не
 * писать** — это проверяется отсутствием любых файлов в подставном DSH_HOME.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginDir, "..");
const script = path.join(repoRoot, "bin", "install-remote.sh");

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Запуск установщика с подставным DSH_HOME. */
function run(t, args, dshHome) {
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: dshHome },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Пусто ли дерево (dry-run не должен ничего создавать). */
function listTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

test("bash -n: синтаксис установщика чист", () => {
  execFileSync("bash", ["-n", script]);
});

test("--help печатает описание и выходит с кодом 0", (t) => {
  const home = tempHome(t);
  const result = run(t, ["--help"], home);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--profile/);
});

test("--dry-run на пустом DSH_HOME: печатает план и ничего не пишет", (t) => {
  const home = tempHome(t);
  const result = run(t, ["--dry-run"], home);

  assert.equal(result.status, 1, "dry-run с проблемами возвращает 1 как машинный план");
  assert.match(result.stdout, /план:/);
  assert.match(result.stdout, /dry-run: ничего не изменено/);
  assert.match(result.stderr, /профиль 'web' не инициализирован/);
  assert.deepEqual(listTree(home), [], "ни одного файла в подставном DSH_HOME");
});

test("--dry-run с профилем: показывает установку, но не меняет манифест", (t) => {
  const home = tempHome(t);
  const profileDir = path.join(home, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  const manifest = path.join(profileDir, "package.json");
  fs.writeFileSync(manifest, JSON.stringify({ name: "web-profile", dependencies: {}, dsh: { profile: { bundles: [] } } }));
  const before = fs.readFileSync(manifest, "utf8");

  const result = run(t, ["--dry-run", "--profile", "web"], home);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dsh plugin|поставлю вручную/);
  assert.equal(fs.readFileSync(manifest, "utf8"), before, "манифест не тронут");
  assert.equal(fs.existsSync(path.join(profileDir, "node_modules")), false, "симлинков нет");
});

test("ручной ряд ui-remote: установка отказывает и объясняет, что делать", (t) => {
  const home = tempHome(t);
  const profileDir = path.join(home, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({ name: "web-profile", dependencies: {}, dsh: { profile: { bundles: [] } } }));
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), "- insert:\n    - id: ui-remote\n      name: 'dsh-remote'\n");

  const result = run(t, ["--profile", "web"], home);

  assert.equal(result.status, 1, "двойной монтаж не допускается");
  assert.match(result.stderr, /уже есть ряд ui-remote/);
  assert.match(result.stderr, /смонтируется дважды/);
});

test("уже установленный пакет: ранний выход и манифест не переписывается", (t) => {
  const home = tempHome(t);
  const profileDir = path.join(home, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  const manifest = path.join(profileDir, "package.json");
  fs.writeFileSync(manifest, JSON.stringify({
    name: "web-profile",
    dependencies: { "dsh-remote": `link:${pluginDir}` },
    dsh: { profile: { bundles: ["dsh-remote"] } },
  }));
  const before = fs.readFileSync(manifest, "utf8");
  const mtimes = fs.statSync(manifest).mtimeMs;

  const result = run(t, ["--profile", "web"], home);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /пакет уже установлен — пропускаю/, "сработал именно ранний выход");
  assert.doesNotMatch(result.stdout, /манифест профиля обновлён/, "запись не выполнялась");
  assert.equal(fs.readFileSync(manifest, "utf8"), before, "манифест байт в байт тот же");
  assert.equal(fs.statSync(manifest).mtimeMs, mtimes, "файл даже не переписан");
  assert.equal(fs.existsSync(path.join(profileDir, "node_modules")), false, "симлинков не появилось");
});

test("файл исполняемый и запускается без bash (режим 100755)", (t) => {
  const mode = fs.statSync(script).mode & 0o111;
  assert.notEqual(mode, 0, "bin/install-remote.sh должен быть +x");

  const home = tempHome(t);
  const result = spawnSync(script, ["--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: home },
  });

  assert.equal(result.status, 1, "dry-run с проблемами возвращает 1");
  assert.match(result.stdout, /dry-run: ничего не изменено/);
});


test("неизвестная опция: код 2 и подсказка", (t) => {
  const home = tempHome(t);
  const result = run(t, ["--takeover"], home);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /неизвестная опция/);
});

test("без --dry-run в заголовке нет пометки «(dry-run)»", (t) => {
  const home = tempHome(t);
  // Пустой DSH_HOME: профиля нет, установка не начнётся — проверяем только вывод.
  const result = run(t, ["--profile", "web"], home);

  assert.equal(result.status, 1, "без профиля установка невозможна");
  assert.match(result.stdout, /dsh-remote → профиль 'web'\n/);
  assert.equal(result.stdout.includes("(dry-run)"), false, "пометка только с флагом");
});

test("--profile вне web|desktop отвергается с кодом 2", (t) => {
  const home = tempHome(t);
  const result = run(t, ["--profile", "staging", "--dry-run"], home);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /неизвестный профиль/);
});

// --- 035: обновление, версии, откат -----------------------------------------

const pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8")).version;

/** Профиль с link-зависимостью на «старую» копию плагина. */
function seedProfile(t, { installedVersion = null } = {}) {
  const home = tempHome(t);
  const profileDir = path.join(home, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  const manifest = path.join(profileDir, "package.json");
  const dependencies = {};
  let oldDir = null;
  if (installedVersion !== null) {
    oldDir = path.join(home, "old-plugin");
    fs.mkdirSync(path.join(oldDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(oldDir, "package.json"), JSON.stringify({ name: "dsh-remote", version: installedVersion, type: "module" }));
    fs.writeFileSync(path.join(oldDir, "lib", "index.js"), "export const installed = true;\n");
    // Пакет до 032: STATE_VERSION ещё нет — установщик обязан считать его legacy 1.
    fs.writeFileSync(path.join(oldDir, "lib", "store.js"), "export const LEGACY_STATE_VERSION = 1;\n");
    dependencies["dsh-remote"] = `link:${oldDir}`;
    fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
    fs.symlinkSync(oldDir, path.join(profileDir, "node_modules", "dsh-remote"));
  }
  fs.writeFileSync(manifest, JSON.stringify({
    name: "web-profile",
    dependencies,
    dsh: { profile: { bundles: dependencies["dsh-remote"] === undefined ? [] : ["dsh-remote"] } },
  }, null, 2));
  return { home, profileDir, manifest, oldDir };
}

function runWithEnv(t, args, env) {
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, DSH_INSTALL_NO_DSH: "1", ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("035: --update --dry-run печатает версии и ничего не меняет", (t) => {
  const { home, manifest } = seedProfile(t, { installedVersion: "0.1.0" });
  const before = fs.readFileSync(manifest, "utf8");

  const result = runWithEnv(t, ["--update", "--dry-run"], { DSH_HOME: home });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /обновление 0\.1\.0 →/);
  assert.match(result.stdout, new RegExp(pluginVersion.replace(/\./g, "\\.")));
  assert.match(result.stdout, /dry-run: ничего не изменено/);
  assert.equal(fs.readFileSync(manifest, "utf8"), before, "манифест не изменён");
  assert.equal(fs.existsSync(path.join(home, "plugin-cache")), false, "кэш не создан");
});

test("035: --update обновляет ссылку и кэширует старую версию; откат возвращает её", (t) => {
  const { home, manifest } = seedProfile(t, { installedVersion: "0.1.0" });

  const update = runWithEnv(t, ["--update"], { DSH_HOME: home });
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /старая версия 0\.1\.0 сохранена в кэш/);

  const cache = path.join(home, "plugin-cache", "dsh-remote", "0.1.0");
  assert.ok(fs.existsSync(path.join(cache, "package.json")), "кэш старой версии есть");
  const updated = JSON.parse(fs.readFileSync(manifest, "utf8"));
  assert.equal(updated.dependencies["dsh-remote"], `link:${path.join(pluginDir)}`, "ссылка на текущий пакет");
  assert.equal(JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8")).version, pluginVersion);

  const rollback = runWithEnv(t, ["--rollback", "0.1.0"], { DSH_HOME: home });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(rollback.stdout, /откат выполнен/);
  const rolled = JSON.parse(fs.readFileSync(manifest, "utf8"));
  assert.equal(rolled.dependencies["dsh-remote"], `link:${cache}`, "ссылка на кэш 0.1.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache, "package.json"), "utf8")).version, "0.1.0");
});

test("035: --update на той же версии идемпотентен, кэш не плодится", (t) => {
  const { home, manifest } = seedProfile(t, { installedVersion: pluginVersion });
  const before = fs.readFileSync(manifest, "utf8");

  const result = runWithEnv(t, ["--update"], { DSH_HOME: home });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /обновление не требуется \(идемпотентно\)|обновление не требуется\./);
  assert.equal(fs.readFileSync(manifest, "utf8"), before);
  assert.equal(fs.existsSync(path.join(home, "plugin-cache")), false);
});

test("035: --rollback без кэша честно отказывает", (t) => {
  const { home } = seedProfile(t, { installedVersion: "0.1.0" });

  const result = runWithEnv(t, ["--rollback", "0.0.9"], { DSH_HOME: home });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /версия 0\.0\.9 не найдена в кэше/);
  assert.match(result.stderr, /установка не выполнена/);
  assert.match(result.stdout, /кэш пополняется при обновлении/);
});

test("035: несовместимый schemaVersion блокирует установку с инструкцией", (t) => {
  const { home, manifest } = seedProfile(t, { installedVersion: "0.1.0" });
  fs.mkdirSync(path.join(home, "remote-control"), { recursive: true });
  fs.writeFileSync(path.join(home, "remote-control", "state.json"), JSON.stringify({ schemaVersion: 99 }));
  const before = fs.readFileSync(manifest, "utf8");

  const result = runWithEnv(t, ["--update"], { DSH_HOME: home });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /schemaVersion 99/);
  assert.match(result.stdout, /состояние из будущего/);
  assert.equal(fs.readFileSync(manifest, "utf8"), before, "установка не тронула профиль");
  assert.equal(fs.existsSync(path.join(home, "plugin-cache")), false);
});

// --- 035, ревью: обход кэша, неполная установка, фейковый dsh ----------------

test("035: --rollback отклоняет version traversal и ссылку вне кэша", (t) => {
  const { home, manifest } = seedProfile(t, { installedVersion: "0.1.0" });
  const before = fs.readFileSync(manifest, "utf8");

  const traversal = runWithEnv(t, ["--rollback", "../../outside"], { DSH_HOME: home });
  assert.equal(traversal.status, 1);
  assert.match(traversal.stderr, /недопустимая версия/);
  assert.equal(fs.readFileSync(manifest, "utf8"), before);

  // Симлинк из кэша наружу: realpath обязан отклонить.
  const outside = path.join(home, "outside-plugin");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "dsh-remote", version: "0.0.5" }));
  fs.mkdirSync(path.join(home, "plugin-cache", "dsh-remote"), { recursive: true });
  fs.symlinkSync(outside, path.join(home, "plugin-cache", "dsh-remote", "0.0.5"));

  const symlink = runWithEnv(t, ["--rollback", "0.0.5"], { DSH_HOME: home });
  assert.equal(symlink.status, 1);
  assert.match(symlink.stderr, /вне кэша/);
  assert.equal(fs.readFileSync(manifest, "utf8"), before);
});

test("035: --update при той же версии, но без bundle — доустанавливает", (t) => {
  const { home, manifest, oldDir } = seedProfile(t, { installedVersion: pluginVersion });
  // Имитируем поломку: версия та же, но бандла в профиле нет, ссылки node_modules нет.
  fs.writeFileSync(manifest, JSON.stringify({
    name: "web-profile",
    dependencies: { "dsh-remote": `link:${oldDir}` },
    dsh: { profile: { bundles: [] } },
  }, null, 2));
  fs.rmSync(path.join(home, "profiles", "web", "node_modules"), { recursive: true, force: true });

  const result = runWithEnv(t, ["--update"], { DSH_HOME: home });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /обновление не требуется/, "нельзя молчать при неполной установке");
  const updated = JSON.parse(fs.readFileSync(manifest, "utf8"));
  assert.equal(updated.dependencies["dsh-remote"], `link:${pluginDir}`);
  assert.deepEqual(updated.dsh.profile.bundles, ["dsh-remote"], "бандл восстановлен");
});

test("035: dsh plugin add без переключения версии — фолбэк на ручную ссылку", (t) => {
  const { home, manifest } = seedProfile(t, { installedVersion: "0.1.0" });
  const bin = path.join(home, "fake-bin");
  fs.mkdirSync(bin, { recursive: true });
  const fakeDsh = path.join(bin, "dsh");
  fs.writeFileSync(fakeDsh, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fakeDsh, 0o755);

  const result = spawnSync("bash", [script, "--update"], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /не переключил версию — обновляю ссылку вручную/);
  const updated = JSON.parse(fs.readFileSync(manifest, "utf8"));
  assert.equal(updated.dependencies["dsh-remote"], `link:${pluginDir}`, "версия фактически переключена");
});

// --- 035, ревью: legacy-схема старых кэш-пакетов ----------------------------

function seedCache(home, version, { storeJs = true, stateVersion = 2 } = {}) {
  const dir = path.join(home, "plugin-cache", "dsh-remote", version);
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "dsh-remote", version, type: "module" }));
  fs.writeFileSync(path.join(dir, "lib", "index.js"), "export const legacy = true;\n");
  if (storeJs) fs.writeFileSync(path.join(dir, "lib", "store.js"), "export const LEGACY_STATE_VERSION = 1;\n");
  if (stateVersion !== null) {
    fs.mkdirSync(path.join(home, "remote-control"), { recursive: true });
    fs.writeFileSync(path.join(home, "remote-control", "state.json"), JSON.stringify({ schemaVersion: stateVersion }));
  }
  return dir;
}

test("035: старый кэш без STATE_VERSION + state v2 — откат заблокирован", (t) => {
  const { home, manifest } = seedProfile(t, { installedVersion: "0.1.0" });
  seedCache(home, "0.0.9", { stateVersion: 2 });
  const before = fs.readFileSync(manifest, "utf8");

  const result = runWithEnv(t, ["--rollback", "0.0.9"], { DSH_HOME: home });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /пакет 0\.0\.9 не поддерживает schemaVersion 2, откат невозможен/);
  assert.match(result.stdout, /обновите пакет или восстановите state\.json из бэкапа/);
  assert.equal(fs.readFileSync(manifest, "utf8"), before, "manifest не тронут");
  assert.equal(fs.readlinkSync(path.join(home, "profiles", "web", "node_modules", "dsh-remote")), path.join(home, "old-plugin"), "link не переключён");
});

test("035: кэш без lib/store.js — понятная ошибка без traceback", (t) => {
  const { home, manifest } = seedProfile(t, { installedVersion: "0.1.0" });
  seedCache(home, "0.0.8", { storeJs: false, stateVersion: 2 });
  const before = fs.readFileSync(manifest, "utf8");

  const result = runWithEnv(t, ["--rollback", "0.0.8"], { DSH_HOME: home });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Traceback|FileNotFoundError/, "без python-traceback");
  assert.match(result.stderr, /не поддерживает schemaVersion 2, откат невозможен/);
  assert.equal(fs.readFileSync(manifest, "utf8"), before);
});

test("035: старый пакет со state v1 откатывается, свежий 0.2.0 со state v2 — тоже", (t) => {
  const { home, manifest } = seedProfile(t, { installedVersion: "0.1.0" });
  seedCache(home, "0.1.0", { stateVersion: 1 });
  let result = runWithEnv(t, ["--rollback", "0.1.0"], { DSH_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).dependencies["dsh-remote"], `link:${path.join(home, "plugin-cache", "dsh-remote", "0.1.0")}`);

  // Кэш текущей версии (STATE_VERSION=2) и state v2: откат разрешён.
  const current = path.join(home, "plugin-cache", "dsh-remote", "0.2.0");
  fs.mkdirSync(path.join(current, "lib"), { recursive: true });
  fs.writeFileSync(path.join(current, "package.json"), JSON.stringify({ name: "dsh-remote", version: "0.2.0", type: "module" }));
  fs.writeFileSync(path.join(current, "lib", "index.js"), "export const current = true;\n");
  fs.copyFileSync(path.join(pluginDir, "lib", "store.js"), path.join(current, "lib", "store.js"));
  fs.writeFileSync(path.join(home, "remote-control", "state.json"), JSON.stringify({ schemaVersion: 2 }));

  result = runWithEnv(t, ["--rollback", "0.2.0"], { DSH_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /откат выполнен/);
});
