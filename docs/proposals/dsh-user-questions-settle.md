# Предложение в хост DSH: `settle`/`cancel` живого вопроса + событие «отвечено»

Версия хоста: **0.2.1-rc.5**. Аудит: [`docs/research/gui-question-retract.md`](../research/gui-question-retract.md)
(задача #058). Потребитель: `dsh-remote`, режим `mirror` (спека 010, задачи 059/063).

## 1. Проблема и сценарий

Человек получает один вопрос в двух представлениях: карточка в GUI и сообщение в
мессенджере. Ответить можно в любом; после первого ответа второе представление
должно исчезнуть, а в сессию должен уйти ровно один ответ.

Сейчас это невозможно (подробно — аудит #058):

- `UserQuestionService` не умеет ни закрыть живой вопрос, ни снять его: есть
  только `ask`/`askTimed`/`attachWait`/`answer`/`continued`, а `answer` работает
  **только для `continued`** (timed-вопрос после таймаута);
- `next()` в waterfall `user-questions/request` передаёт владение мосту GUI;
  после этого плагин не может вернуть ответ за GUI;
- в forwarded-allowlist `api-remotes` есть только `user-questions/request`;
  события «ответили/сняли» в браузер не приходят.

Живой кейс: MAX-канал и GUI показывают один вопрос; ответ в мессенджере не
закрывает плашку GUI, ответ в GUI не закрывает сообщение MAX, а плагин не узнаёт
о втором ответе до возврата waterfall.

## 2. Точные места хоста (0.2.1-rc.5)

`@deepseek-ai/dsh-user-questions/lib/index.js`:

| Что | Строки |
|---|---|
| `ask(request)` — waterfall, единственный путь ответа | 668–686 |
| `askTimed(request, callId, timeoutMs)` — foreground wait + pending | 613–661 |
| `answer(agent, callId, answer)` — только `continued` | 552–594 |
| `waits` — `Map<agent, Map<callId, TimedQuestionWait>>` | 487 |
| `queuedReplies` — WeakMap для `continued`-ответов | 488 |
| `TimedQuestionWait.close(reason)` — аборт foreground-сигнала | 371–376 |

`@deepseek-ai/dsh-api-remotes/lib/index.js`:

- allowlist forwarded-событий — строки 120–140, единственный вопрос —
  `user-questions/request` (waterfall), строки 136–139.

`@deepseek-ai/dsh-client-ui-user-questions/lib/client.js`:

- `dismiss()`: для tool-call-keyed карточки — `hide`, не отмена (413–421);
- удаление карточки — 1881: только когда проекция `userQuestions` больше не
  содержит call и у карточки нет живого request/waterfall.

`@deepseek-ai/dsh-tool-ask-user/lib/index.js`: legacy-вызов передаёт
`wait: { callId }` (197), timed — `askTimed` (186–190).

## 3. Эскиз API (минимально нужное плагину)

```ts
interface UserQuestionService {
  /**
   * Закрыть ЖИВОЙ вопрос ответом, как будто человек ответил в GUI.
   * - только exact live root agent (как answer/attachWait);
   * - callId — из request.wait.callId;
   * - answer — полный батч: один item на каждый question.id;
   * - первый вызов побеждает; повторный/после GUI/для continued — false;
   * - карточка GUI снимается, ask() возвращает этот answer.
   */
  settle(agent: Agent, callId: string, answer: AskUserQuestionAnswer): boolean;

  /** Снять живой вопрос: ask() отклоняется UserQuestionError(code), карточка исчезает. */
  cancel(agent: Agent, callId: string, reason?: string): boolean;

  /** Необязательно, но полезно для feature-detect. */
  readonly capabilities?: {
    liveSettle: true;
    liveCancel: true;
    resolvedEvent: true;
  };

  /** Событие Cordis; forwarded в браузер (allowlist). */
  // ctx.emit("user-questions/resolved", payload)
}

interface UserQuestionResolvedEvent {
  callId: string;
  agentId: string;
  sessionId: string;          // нужен клиенту, чтобы найти карточку
  outcome: "answered" | "cancelled";
  source: "gui" | "remote" | "signal";
  reason?: string;            // для cancelled
}
```

Инварианты:

1. **Идемпотентность.** `settle`/`cancel` удаляют запись из реестра; повторный
   вызов возвращает `false`, не бросает.
2. **Первый побеждает.** `settle` до ответа GUI → `ask()` получает `settle`-ответ,
   поздний GUI-ответ отбрасывается. GUI ответил первым → `settle` возвращает
   `false`; `ask()` уже вернул GUI-ответ.
3. **Событие один раз.** На каждый callId ровно одно `resolved`; `source`
   говорит, кто закрыл.
4. **`continued` не ломаем.** Для timed-вопроса после `pending` работает
   существующий `answer` (steer), `settle` для него — `false`.

## 4. Эскиз кода (не патч приложения)

### 4.1. `UserQuestionService`: реестр живых вопросов

Сейчас `ask()` не регистрирует запрос нигде, кроме waterfall; `waits` есть только
у `askTimed`. Добавляем отдельный реестр для **всех** живых вопросов с
`request.wait?.callId` и `agent`:

```js
// lib/index.js, рядом с waits (487)
live = new Map(); // agent -> Map<callId, LiveQuestion>

/**
 * @typedef {{
 *   promise: Promise<AskUserQuestionAnswer>,
 *   resolve: (answer) => void,
 *   reject: (error) => void,
 *   controller: AbortController,
 *   questions: AskUserQuestionItem[],
 *   settled: boolean,
 * }} LiveQuestion
 */

#registerLive(request, callId) {
  const agent = request.agent;
  const deferred = Promise.withResolvers();
  const entry = {
    promise: deferred.promise,
    resolve: deferred.resolve,
    reject: deferred.reject,
    controller: new AbortController(),
    questions: request.questions,
    settled: false,
  };
  const calls = this.live.get(agent) ?? new Map();
  if (calls.has(callId)) {
    throw new UserQuestionError("the question call already has a live entry", "DUPLICATE_WAIT");
  }
  calls.set(callId, entry);
  this.live.set(agent, calls);
  return entry;
}

#releaseLive(agent, callId, entry) {
  const calls = this.live.get(agent);
  if (calls?.get(callId) !== entry) return false;
  calls.delete(callId);
  if (calls.size === 0) this.live.delete(agent);
  return true;
}

#emitResolved(agent, callId, outcome, source, reason) {
  // api-remotes: добавить { event: "user-questions/resolved", mode: "emit" }
  this.ctx.emit("user-questions/resolved", {
    callId,
    agentId: agent.id,
    sessionId: agent.session,
    outcome,
    source,
    ...(reason === undefined ? {} : { reason }),
  });
}

settle(agent, callId, answer) {
  this.assertLiveRoot(agent);
  const entry = this.live.get(agent)?.get(callId);
  if (entry === undefined) return false;
  // та же проверка батча, что в answer(): один item на каждый question.id
  validateAnswerBatch(entry.questions, answer);
  if (!this.#releaseLive(agent, callId, entry)) return false;
  entry.settled = true;
  entry.resolve(answer);
  // завершаем представление GUI, не трогая tool-call
  entry.controller.abort(new UserQuestionError("question settled by remote", "ASK_SETTLED"));
  this.#emitResolved(agent, callId, "answered", "remote");
  return true;
}

cancel(agent, callId, reason = "ASK_CANCELLED") {
  this.assertLiveRoot(agent);
  const entry = this.live.get(agent)?.get(callId);
  if (entry === undefined) return false;
  if (!this.#releaseLive(agent, callId, entry)) return false;
  entry.settled = true;
  const error = new UserQuestionError("ask_user_question was cancelled", reason);
  entry.reject(error);
  entry.controller.abort(error);
  this.#emitResolved(agent, callId, "cancelled", "remote", reason);
  return true;
}
```

`ask()` (668) меняется в одном месте: для вопроса с `agent` и
`request.wait?.callId` регистрирует live-запись, подмешивает её сигнал в waterfall
и гоняет waterfall с `live.promise`:

```js
async ask(request) {
  // ... прежние проверки (668–679)
  const agent = request.agent;
  const callId = request.wait?.callId;
  const live = agent !== undefined && callId !== undefined
    ? this.#registerLive(request, callId)
    : null;
  const signal = live === null
    ? request.signal
    : (request.signal === undefined
      ? live.controller.signal
      : AbortSignal.any([request.signal, live.controller.signal]));
  const waterfall = this.ctx.waterfall(/* как сейчас */, { ...request, signal }, noAnswerer);
  try {
    if (live === null) return await waterfall;
    // waterfall может проиграть settle; ошибка проигравшего не должна всплывать
    waterfall.catch(() => {});
    const answer = await Promise.race([waterfall, live.promise]);
    if (!live.settled) this.#emitResolved(agent, callId, "answered", "gui");
    return answer;
  } finally {
    if (live !== null) this.#releaseLive(agent, callId, live);
  }
}
```

Замечания к эскизу:

- `entry.controller` — **внутренний** сигнал представления. Аборт при `settle`
  завершает forwarded waterfall (клиент получает cancel frame), но **не**
  отменяет tool-call: `ask()` уже получил ответ из `live.promise`.
- `askTimed` (613) продолжает работать как есть: для него `settle` действует,
  пока идёт foreground wait; после `pending` — только `answer`.
- Если у запроса нет `agent`/`callId` (legacy без wait), `live` не создаётся:
  `settle` вернёт `false`, поведение не меняется.
- `validateAnswerBatch` — вынести общую проверку из `answer` (552–594), чтобы
  `BAD_ANSWER` был одинаковым.

### 4.2. `api-remotes`: forwarded-событие

`lib/index.js`, allowlist (120–140) — один entry:

```js
{ event: "user-questions/resolved", mode: "emit" },
```

`assertJsonArgs` уже требует lossless JSON; payload выше ему удовлетворяет. В
браузер событие уходит как обычный notify; подписка на клиенте — через
`ClientRemoteEvents.subscribe` (api-gateway `lib/types/client/remote-events.js`),
т.е. в клиентском плагине:

```js
ctx.remote.events.subscribe("user-questions/resolved", (payload) => {
  cards.byCallId(payload.sessionId, payload.callId)?.remove();
});
```

### 4.3. `dsh-client-ui-user-questions`: удаление карточки

В `QuestionCards` уже есть `remove()` (1702–1712) и поиск `byCallId` (1659). Нужен
подписчик на forwarded `resolved`:

```js
// рядом с publishContinuedQuestions / reconcile (1840+)
const stopResolved = ctx.remote.events.subscribe("user-questions/resolved", (payload) => {
  if (payload.outcome === "answered" || payload.outcome === "cancelled") {
    cards.byCallId(payload.sessionId, payload.callId)?.remove();
  }
});
```

Для `source: "remote"` карточка просто исчезает; в чате остаётся tool-result с
ответом. Если нужен читаемый след, можно показать review-карточку с пометкой
«отвечено в мессенджере» — это презентационное решение, не влияет на API.

## 5. Ограничения и риски

- **`waits` приватны.** Предложение не открывает их наружу; `settle`/`cancel`
  работают через новый реестр и `assertLiveRoot`, как `answer`/`attachWait`.
- **Обратная совместимость.** Старые хосты не имеют методов → плагин
  feature-detect и деградирует в B; новые хосты без события → плагин не узнаёт
  «ответили в GUI» до возврата waterfall (B остаётся работоспособным).
- **`continued`.** `settle` не заменяет `answer`: после `pending` ответ идёт
  steer-сообщением, чтобы не ломать модель и историю.
- **Legacy без callId.** Вопрос без `wait.callId` нельзя адресно снять; такие
  вызовы остаются best-effort.
- **Гонка.** Первый `settle`/GUI-ответ выигрывает; второй получает `false` и не
  пишет в сессию. Это надо покрыть тестом с одновременным `resolve`/`settle`.
- **Приватность.** В событие не попадают текст вопроса/ответа — только callId,
  agentId/sessionId, outcome/source/reason.
- **Безопасность.** `settle`/`cancel` требуют exact live root agent; иначе
  `CALLER_NOT_LIVE`/`DELEGATED_CALLER`.

## 6. Почему не патчим `app.asar`

Патч `app.asar`:

- ломает подпись приложения (macOS/Electron) и может не запуститься;
- стирается при обновлении DSH;
- создаёт форк, который мы не сможем поддерживать;
- не решает проблему для других пользователей.

Правильный путь — предложение вендору (issue/PR в их трекер) с этим эскизом; наш
плагин должен **feature-detect** и не зависеть от форка. `dsh-remote` остаётся
совместимым с 0.2.1-rc.5 и более старыми хостами.

## 7. Тесты для хоста (как проверять)

1. `settle` до ответа GUI → `ask()` возвращает переданный answer; карточка
   удаляется по `resolved`; событие одно, `source:"remote"`.
2. `settle` после ответа GUI → `false`, `ask()` уже вернул GUI-ответ, второго
   `resolved` нет.
3. `cancel` → `ask()` отклоняется `ASK_CANCELLED`, событие `outcome:"cancelled"`,
   карточка удалена.
4. `settle`/`cancel` с чужим агентом → `CALLER_NOT_LIVE`; для `continued` —
   `false`, работает `answer`.
5. Гонка `settle` + GUI `resolve` → ровно один ответ, победитель — первый,
   проигравший получает `false`/игнорируется; в сессии один tool-result.
6. Аборт `request.signal` → `ASK_ABORTED`, событие `source:"signal"` (если
   добавляем), pending пуст.
7. Регресс: legacy без `wait.callId` и timed `continued` не меняются.

## 8. Как проверить, что хост поддерживает (для 063)

```js
const uq = ctx.get("userQuestions");
const canSettle = typeof uq?.settle === "function" && typeof uq?.cancel === "function";
// если хост даёт явные capabilities — предпочесть их:
const caps = uq?.capabilities;
const fullMirror = canSettle && (caps === undefined || caps.resolvedEvent === true);
```

Рекомендуется добавить в сервис явное `capabilities` (см. §3), потому что наличие
forwarded-события нельзя проверить по прототипу сервиса. Без `settle` плагин
работает в режиме B (GUI — источник истины); с `settle`/`cancel` — полное
зеркало: ответ из канала вызывает `settle`, ответ GUI приходит событием и гасит
сообщение.
