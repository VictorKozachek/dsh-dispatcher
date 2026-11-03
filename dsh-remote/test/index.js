/**
 * Точка входа каталога тестов: `node --test dsh-remote/test`.
 *
 * Начиная с Node 22 позиционные аргументы `node --test` — это glob'ы, и голый
 * каталог по ним не раскрывается (`Cannot find module .../test`). Поэтому у
 * каталога есть `index.js`: node запускает его как файл теста, а он подключает
 * тесты плагина. Запуск по имени файла (`node --test .../*.spec.js`) работает и
 * без этой точки входа.
 *
 * Новый тест — одна строка здесь; список явный, чтобы порядок вывода не зависел
 * от обхода каталога.
 */

import "./plugin.spec.js";
import "./transport.spec.js";
import "./question.spec.js";
import "./registry.spec.js";
import "./answerer.spec.js";
import "./telegram.spec.js";
import "./routing.spec.js";
