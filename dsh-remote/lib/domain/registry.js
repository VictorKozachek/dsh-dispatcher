/**
 * Реестр режима: включено ли удалённое управление для конкретного вопроса.
 *
 * Правило одно и простое: чем ближе настройка, тем она главнее —
 * **сессия → воркспейс → глобально**. Нет ни одной — режим выключен (и это
 * нормальный рабочий режим: плагин отдаёт вопрос в GUI, поведение DSH не меняется).
 *
 * Источник состояния **инжектируется** (`readState`): настоящий файл
 * `~/.dsh/remote-control/state.json` появится в задаче 005 вместе с командами
 * `/remote`. Ожидаемая форма состояния:
 *
 * ```js
 * {
 *   global: true,                       // включён везде
 *   workspaces: { "/path/to/project": false },  // выключен в этом каталоге
 *   sessions:   { "session-id": true },         // включён для этой сессии
 * }
 * ```
 *
 * Значение — только `boolean`. `readState` может бросить: реестр тогда считает,
 * что настроек нет (режим выключен), а не роняет ответчик.
 */

const noopLog = () => {};

/** Каталог сравниваем без хвостового разделителя: `"/a/b/"` и `"/a/b"` — одно. */
function normalizeWorkspace(workspace) {
  if (typeof workspace !== "string" || workspace === "") return null;
  if (workspace === "/") return workspace;
  return workspace.replace(/[\\/]+$/, "");
}

const isBool = (value) => typeof value === "boolean";

/**
 * @param {object} [options]
 * @param {() => object} [options.readState] — источник состояния (005 подставит файл).
 * @param {(message: string) => void} [options.log]
 */
export function createRegistry({ readState, log = noopLog } = {}) {
  /** Состояние на текущий момент: битый источник — пустые настройки. */
  function state() {
    try {
      const value = typeof readState === "function" ? readState() : undefined;
      if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
      return value;
    } catch (error) {
      log(`реестр режима: источник состояния недоступен (${error?.message ?? error})`);
      return {};
    }
  }

  /**
   * Решение по вопросу: включён ли режим и какая настройка его включила.
   *
   * @param {{sessionId?: string|null, workspace?: string|null}} [scope]
   * @returns {{enabled: boolean, scope: 'session'|'workspace'|'global'|null}}
   */
  function resolve({ sessionId, workspace } = {}) {
    const current = state();

    if (typeof sessionId === "string" && sessionId !== ""
      && current.sessions !== null && typeof current.sessions === "object"
      && isBool(current.sessions[sessionId])) {
      return { enabled: current.sessions[sessionId], scope: "session" };
    }

    const target = normalizeWorkspace(workspace);
    if (target !== null && current.workspaces !== null && typeof current.workspaces === "object") {
      const match = Object.entries(current.workspaces)
        .find(([path]) => normalizeWorkspace(path) === target);
      if (match !== undefined && isBool(match[1])) {
        return { enabled: match[1], scope: "workspace" };
      }
    }

    if (isBool(current.global)) {
      return { enabled: current.global, scope: "global" };
    }

    return { enabled: false, scope: null };
  }

  return {
    resolve,
    /** Короткая форма для проверок: включён ли режим для этого scope. */
    enabled(scope = {}) {
      return resolve(scope).enabled;
    },
  };
}
