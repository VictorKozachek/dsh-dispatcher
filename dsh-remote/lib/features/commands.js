/**
 * Фича «commands»: регистрирует `/remote` в реестре команд DSH.
 *
 * Нужна одна строка в `lib/features.js`. Состояние — `store.js` (файл
 * `~/.dsh/remote-control/state.json`), токен — только через `ctx.credentials`.
 * Если `ctx.commands` в контексте нет (урезанный профиль), фича тихо пишет в лог
 * и ничего не регистрирует: плагин обязан деградировать, а не падать.
 */

import { createRemoteCommands } from "../commands.js";
import { createStore } from "../store.js";

export const commandsFeature = {
  name: "commands",
  needs: [],
  apply(ctx, config, deps) {
    const log = (message) => deps.logger.debug(message);
    const store = createStore({ log });
    const remote = createRemoteCommands({ ctx, store, log });
    deps.onDispose(remote.register());
    deps.logger.info("фича commands: /remote зарегистрирована");
  },
};
