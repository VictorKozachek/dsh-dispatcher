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

test("уже установленный пакет: повторный запуск идемпотентен", (t) => {
  const home = tempHome(t);
  const profileDir = path.join(home, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({
    name: "web-profile",
    dependencies: { "dsh-remote": `link:${pluginDir}` },
    dsh: { profile: { bundles: ["dsh-remote"] } },
  }));

  const result = run(t, ["--profile", "web"], home);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /уже установлен|уже объявлен зависимостью/);
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
