/**
 * Точка входа каталога тестов: `node --test dsh-remote/test`.
 *
 * Начиная с Node 22 позиционные аргументы `node --test` — это glob'ы, и голый
 * каталог по ним не раскрывается (`Cannot find module .../test`). Поэтому у
 * каталога есть `index.js`: node запускает его как файл теста, а он подключает
 * все `*.spec.js` рядом.
 *
 * Список собирается по каталогу, а не перечисляется руками: новая задача просто
 * кладёт свой `*.spec.js` и НЕ правит этот файл — так он не конфликтует при
 * слиянии веток (раньше каждая задача дописывала сюда импорт, и каждое слияние
 * требовало ручной развязки).
 */

import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const specs = readdirSync(here)
  .filter((name) => name.endsWith(".spec.js"))
  .sort();

for (const spec of specs) {
  await import(pathToFileURL(`${here}/${spec}`).href);
}
