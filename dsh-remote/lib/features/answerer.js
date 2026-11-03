/**
 * Фича «ответчик»: вопрос человека уходит в транспорт мессенджера.
 *
 * Подключается к каркасу одной строкой в `lib/features.js`. Транспорта пока нет
 * (его объявит задача 003), поэтому фича заявляет его в `needs`: каркас пропустит
 * её с предупреждением, и вопрос спокойно уйдёт в GUI — поведение DSH не меняется.
 *
 * Состояние режима (`~/.dsh/remote-control/state.json`) появится в задаче 005;
 * пока источник пустой, значит режим выключен, и это тот же безопасный путь.
 */

import { createAnswerer } from "../answerer.js";
import { createRegistry } from "../domain/registry.js";

/** Имя сервиса транспорта: его объявит задача 003 (`dsh-remote/lib/transport`). */
export const TRANSPORT_SERVICE = "remoteTransport";

export const answererFeature = {
  name: "answerer",
  needs: [TRANSPORT_SERVICE],
  apply(ctx, config, deps) {
    const registry = createRegistry({
      // Задача 005 подставит сюда чтение состояния; до тех пор настройка пуста,
      // то есть удалённый режим выключен и вопрос уходит в GUI.
      readState: () => ({}),
      log: (message) => deps.logger.debug(message),
    });

    // Устойчивость (008): доставка с повторами и TTL-сторож живут в отдельной
    // фиче; здесь только передаём их ответчику.
    const reliability = deps.get("remoteReliability");

    const answerer = createAnswerer({
      transport: deps.get(TRANSPORT_SERVICE),
      registry,
      reliability,
      deliver: reliability === null ? null : (argument) => reliability.deliver(argument),
      log: (message) => deps.logger.debug(message),
    });

    deps.onDispose(answerer.attach(ctx));
  },
};
