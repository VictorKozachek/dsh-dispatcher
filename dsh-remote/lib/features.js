/**
 * Реестр фич плагина `dsh-remote`.
 *
 * Фича — одна строка в массиве `features`. Поэтому следующие задачи (ответчик
 * `user-questions/request`, транспорты, команды `/remote`, хранилище) подключаются
 * здесь, а `lib/index.js` не правится и не конфликтует при слиянии веток.
 *
 * Фича — объект:
 *   name:  строка, короткое имя для лога и сообщений об отказе;
 *   needs: необязательный список сервисов `ctx` (например `["userQuestions"]`).
 *          Сервиса нет — плагин пишет warn и фичу пропускает; остальные фичи и
 *          сам DSH работают дальше;
 *   apply: (ctx, config, deps) => void | Promise<void> — точка входа фичи.
 *
 * `deps` — то, что даёт каркас:
 *   deps.logger     — логгер `[dsh-remote]` (уровни debug/info/warn/error);
 *   deps.get(name)  — сервис из ctx или null, без исключений;
 *   deps.onDispose  — снятие ресурсов фичи при выгрузке плагина.
 *
 * Пока подключены две фичи: транспорт (`./features/telegram.js`) и ответчик
 * (`./features/answerer.js`). **Порядок важен**: ответчик объявляет
 * `needs: [remoteTransport]`, а каркас проверяет сервисы по порядку реестра,
 * поэтому транспорт должен зарегистрироваться раньше. Без привязки в состоянии
 * (её заведёт задача 005) транспорт спит — вопрос уходит в GUI, как и раньше.
 */
import { telegramFeature } from "./features/telegram.js";
import { answererFeature } from "./features/answerer.js";

export const features = [
  telegramFeature,
  answererFeature,
];
