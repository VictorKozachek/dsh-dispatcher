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
 * Сейчас подключены: команды, каналы (telegram/max/relay), устойчивость,
 * ответчик вопросов, ответчик подтверждений (024) и панель. **Порядок важен**:
 * ответчики объявляют `needs: [remoteTransport]`, а каркас проверяет сервисы по
 * порядку реестра, поэтому транспорт должен зарегистрироваться раньше. Каркас дожидается каждой фичи (`apply` асинхронный), так что
 * асинхронная привязка бота успевает появиться до проверки `needs`.
 * Без привязки (ни config.telegram, ни сохранённого состояния) транспорт спит —
 * вопрос уходит в GUI, как и раньше; `/remote connect` заводит привязку.
 */
import { commandsFeature } from "./features/commands.js";
import { journalFeature } from "./features/journal.js";
import { metricsFeature } from "./features/metrics.js";
import { maxFeature } from "./features/max.js";
import { telegramFeature } from "./features/telegram.js";
import { reliabilityFeature } from "./features/reliability.js";
import { answererFeature } from "./features/answerer.js";
import { approvalsFeature } from "./features/approvals.js";
import { notifyFeature } from "./features/notify.js";
import { relayFeature } from "./features/relay.js";
import { panelFeature } from "./features/panel.js";

// Порядок: commands регистрирует фасад remoteTransport и состояние, telegram
// кладёт транспорт в фасад (config-путь), reliability даёт ответчику deliver и
// TTL-сторож, answerer подписывается последним.
export const features = [
  journalFeature,
  metricsFeature,
  commandsFeature,
  maxFeature,
  telegramFeature,
  reliabilityFeature,
  answererFeature,
  approvalsFeature,
  relayFeature,
  notifyFeature,
  panelFeature,
];
