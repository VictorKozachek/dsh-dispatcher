/**
 * Валидатор подмножества JSON Schema 2020-12 для схемы релея (задача 016).
 *
 * Схема — часть контракта, поэтому валидатор живёт рядом с ней и не тянет
 * npm-зависимостей: `node:` builtins и чистый JS. Поддержано ровно то, что
 * использует `schema.json`: `$ref` (локальные `#/...`), `type`, `required`,
 * `properties`, `additionalProperties`, `enum`, `const`, `items`, `oneOf`,
 * `minLength`/`maxLength`, `minimum`/`maximum`, `minItems`/`maxItems`,
 * `pattern`.
 *
 * Возвращает `{ok, errors}`; `errors` — список путей и причин.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Загрузить схему релея из `docs/relay/schema.json`. */
export function loadSchema() {
  return JSON.parse(readFileSync(path.join(HERE, "schema.json"), "utf8"));
}

/** Разрешить локальный `$ref` вида `#/components/schemas/X`. */
function resolveRef(schema, ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`неподдерживаемый $ref: ${ref}`);
  }
  let node = root;
  for (const part of ref.slice(2).split("/")) {
    if (node === null || typeof node !== "object" || !(part in node)) {
      throw new Error(`$ref не разрешён: ${ref}`);
    }
    node = node[part];
  }
  return node;
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

/**
 * Проверить значение по схеме.
 *
 * @param {object} schema — фрагмент схемы (или корень со `$ref`).
 * @param {any} value — проверяемое значение.
 * @param {object} [options] — `{root}` корень для `$ref`.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validate(schema, value, options = {}) {
  const root = options.root ?? schema;
  const errors = [];
  walk(schema, value, root, "$", errors);
  return { ok: errors.length === 0, errors };
}

function walk(schema, value, root, where, errors) {
  if (schema === null || typeof schema !== "object") return;

  if (typeof schema.$ref === "string") {
    walk(resolveRef(schema, schema.$ref, root), value, root, where, errors);
    return;
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) walk(branch, value, root, where, errors);
  }

  if (Array.isArray(schema.anyOf)) {
    const matching = schema.anyOf.filter((branch) => {
      const branchErrors = [];
      walk(branch, value, root, where, branchErrors);
      return branchErrors.length === 0;
    }).length;
    if (matching === 0) errors.push(`${where}: ни один вариант anyOf не подошёл`);
  }

  if (schema.not !== undefined) {
    const innerErrors = [];
    walk(schema.not, value, root, where, innerErrors);
    if (innerErrors.length === 0) errors.push(`${where}: запрещённая конструкция (not)`);
  }

  if (Array.isArray(schema.oneOf)) {
    const outcomes = schema.oneOf.map((branch) => {
      const branchErrors = [];
      walk(branch, value, root, where, branchErrors);
      return branchErrors;
    });
    const matching = outcomes.filter((branchErrors) => branchErrors.length === 0).length;
    if (matching === 0) {
      errors.push(`${where}: ни один вариант oneOf не подошёл (${outcomes.map((item) => item[0]).join(" | ")})`);
      return;
    }
    if (matching > 1) {
      errors.push(`${where}: одновременно подошли ${matching} варианта oneOf (нужен ровно один)`);
      return;
    }
    // Ветка oneOf может нести и общие ключи (required/properties) — их проверяем
    // отдельно, чтобы `required` рядом с `oneOf` не терялся.
    const { oneOf, ...rest } = schema;
    if (Object.keys(rest).length > 0) walk(rest, value, root, where, errors);
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${where}: ожидалось const ${JSON.stringify(schema.const)}, получено ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
    errors.push(`${where}: значение ${JSON.stringify(value)} не из enum ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${where}: ожидался тип ${types.join("|")}, получен ${typeOf(value)}`);
      return; // дальше проверять бессмысленно
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${where}: строка короче ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${where}: строка длиннее ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") {
      const regexp = new RegExp(schema.pattern);
      if (!regexp.test(value)) errors.push(`${where}: строка не соответствует ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${where}: меньше минимума ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${where}: больше максимума ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${where}: элементов меньше ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${where}: элементов больше ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => walk(schema.items, item, root, `${where}[${index}]`, errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${where}: нет обязательного поля ${required}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) {
        walk(properties[key], item, root, `${where}.${key}`, errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${where}: лишнее поле ${key}`);
      } else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === "object") {
        walk(schema.additionalProperties, item, root, `${where}.${key}`, errors);
      }
    }
  }
}

/** Все `$ref` схемы — для проверки, что они разрешаются. */
export function collectRefs(schema, found = new Set()) {
  if (schema === null || typeof schema !== "object") return found;
  if (typeof schema.$ref === "string") found.add(schema.$ref);
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const item of value) collectRefs(item, found);
    } else if (value !== null && typeof value === "object") {
      collectRefs(value, found);
    }
  }
  return found;
}
