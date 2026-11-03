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

  assert.equal(result.status, 0, result.stderr);
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

  assert.equal(result.status, 0, result.stderr);
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
    fs.writeFileSync(path.join(oldDir, "lib", "store.js"), "export const STATE_VERSION = 2;\n");
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
