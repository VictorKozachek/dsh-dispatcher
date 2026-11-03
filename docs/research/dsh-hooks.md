# DSH: хуки и сервисы для перехвата вопросов агента и доставки ответов

Исследование по исходникам **DeepSeek Harness** и живому плагину **dsh-kanban**.
Цель — понять, какими API плагин может (а) перехватить вопрос агента к человеку,
(б) отправить его во внешний мессенджер, (в) принять ответ и вернуть его в сессию.

Отчёт писан под плагин `dsh-remote` этого проекта (`docs/CONCEPT.md`,
`.kanban/specs/001.md`): §1–§8 — факты о DSH с ссылками на код, §9 — что из них
следует для дизайна и как требования спеки ложатся на реальные API.

**Что читалось (revision-фиксация):**

- `/Users/victor/projects/deepseek-harness` — монорепо DSH, HEAD `0a53fb55` (2026-08-30,
  релиз `0.1.2-alpha.2`). Только чтение, ничего не менялось.
- `/Users/victor/projects/dsh-kanban/dsh-kanban` — плагин с host- и client-половиной.

Все ссылки вида `путь:строка` — относительно корня соответствующего репозитория.
Пометки: **[код]** — прочитано в исходниках; **[эксперимент]** — из кода следует, но
поведение нужно подтвердить запуском (там, где важен порядок монтирования, реальный
сетевой путь или недокументированный инвариант).

---

## 0. Карта механизма в одном абзаце

Модель вызывает инструмент `ask_user_question` → инструмент зовёт сервис
`ctx.userQuestions.ask()` → сервис разворачивает **Cordis-waterfall**
`user-questions/request` → слушатели в этом waterfall'е либо возвращают ответ,
либо зовут `next()` и передают ход дальше → один из слушателей — мост
`api-remotes`, который отправляет событие подключённому браузеру → GUI рисует
панель вопроса и возвращает ответ как **возвращаемое значение** этого же
waterfall'а → ответ едет обратно в инструмент и попадает в лог как обычный
tool-result **[код]**. Ключевой вывод: **вопрос — это waterfall, а не RPC
«отправить ответ»; перехватить его можно только встав свой слушатель в цепочку,
а «вернуть ответ» = вернуть значение из слушателя.**

---

## 1. Инструмент вопроса человеку: имя, контракт, UI, путь ответа

### 1.1. Имя и регистрация

Инструмент называется `ask_user_question`. Он регистрируется пакетом
`@deepseek-ai/dsh-tool-ask-user` («Model-facing ask_user_question tool over the
ctx.userQuestions seam»).

```ts
// packages/interaction/tool-ask-user/src/index.ts:13-21
export const name = 'tool-ask-user'
export const inject = ['tools', 'userQuestions']

const description = 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
  + 'Send one or more questions, each with a stable id that will be echoed in the answer.'

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
```

Других инструментов «спросить человека» в чекауте нет; отдельно существует
`exit_plan_mode` в `packages/plan/plan-mode/src/index.ts:270-320`, который зовёт
`ctx.userQuestions.ask()` **напрямую из тела инструмента** (см. §2.5 — это
важный образец).

### 1.2. Схема аргументов (model-facing)

```ts
// packages/interaction/tool-ask-user/src/index.ts:23-56
parameters: {
  questions: {
    type: 'array', required: true,
    items: {
      type: 'object', additionalProperties: true,
      properties: {
        id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
        question: { type: 'string', required: true, ... },
        header: { type: 'string', ... },
        options: { type: 'array', items: { ... label (required), description ... } },
        multi_select: { type: 'boolean', ... },
      },
    },
  },
},
```

Обратите внимание: в model-facing схеме поле называется `multi_select`, а во
внутреннем типе — `multiSelect`; переименование делает `execute`
(`tool-ask-user/src/index.ts:82-88`) **[код]**.

### 1.3. Схема результата (то, что видит модель)

```ts
// packages/interaction/tool-ask-user/src/index.ts:58-79
output: {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      answers: {
        type: 'array', required: true,
        items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true },
          selected: { type: 'array', required: true, items: { type: 'string' } },
          custom: { type: 'string' },
        } },
      },
    },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
},
```

Модель получает **JSON-строку** `{"answers":[{"id","selected":[...],"custom"?}]}` в
текстовом блоке **[код]**. Ответ приходит по одному элементу на `id` вопроса.

### 1.4. Внутренний контракт (то, что важно плагину)

Сервис-шов — `ctx.userQuestions`, класс `UserQuestionService`
(`packages/interaction/user-questions/src/index.ts:65`).

Внутренние типы (`packages/interaction/user-questions/src/types.ts`):

```ts
// types.ts:7-12
export interface AskUserQuestionOption { label: string; description?: string }
// types.ts:33-48
export interface AskUserQuestionItem {
  id: string; question: string; detail?: string; header?: string
  options?: AskUserQuestionOption[]; multiSelect?: boolean
  intent?: AskUserQuestionIntent   // 'plan-review' — только презентация
}
// types.ts:51-64
export interface AskUserQuestionAnswerItem { id: string; selected: string[]; custom?: string }
export interface AskUserQuestionAnswer { answers: AskUserQuestionAnswerItem[] }
// types.ts:67-74
export interface AskUserQuestionRequestEvent {
  questions: AskUserQuestionItem[]
  agent?: Agent            // проекция личности агента
  signal?: AbortSignal     // время жизни запроса
}
```

Метод `ask()` (`packages/interaction/user-questions/src/index.ts:86-151`) делает
три вещи: валидирует запрос, проверяет «живого» вызывающего и разворачивает
waterfall:

```ts
// user-questions/src/index.ts:130-142
const noAnswerer = () => Promise.reject(new UserQuestionError(
  'no user-questions answerer accepted the request', 'NO_PROVIDER'))
return await (agent === undefined
  ? this.ctx.waterfall('user-questions/request', request, noAnswerer)
  : this.ctx.waterfall(
    scopeTarget(agent, agent),
    'user-questions/request',
    { ...request, agent },
    noAnswerer,
  ))
```

Важные следствия **[код]**:

- Если **ни один** слушатель не вернул ответ, инструмент падает с
  `UserQuestionError`/`NO_PROVIDER` (`index.ts:130-133`).
- Есть защита от «делегированного» вызывающего: вопрос разрешён только для
  живого runtime-root агента, иначе `CALLER_NOT_LIVE` / `DELEGATED_CALLER`
  (`index.ts:93-107`). То есть субагент спросить человека не может.
- Ошибки несут стабильные коды (`ASK_ABORTED`, `EMPTY_QUESTIONS`, `NO_PROVIDER`,
  `BAD_INTENT`) и переживают `ctx.tools.execute()` как `{name, code}`
  (`docs/subsystems/user-questions.md:106`).

### 1.5. Что происходит в UI

Клиентская половина — `@deepseek-ai/dsh-client-ui-user-questions`
(`packages/client/ui-user-questions/src/client/index.ts`).

```ts
// ui-user-questions/src/client/index.ts:52
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']
// :98-99  — панель вопроса подменяет собой композер (цепочка conversation.composer)
ctx.slots.inject('conversation.composer', () => ctx.slots.register(
  { name: 'conversation.composer',
    select: ({ pendingInteraction }) => pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,
    ... },
  QuestionComposer,
))
// :104-106 — подписка на форварднутое host-событие
ctx.remote.$on('user-questions/request', function (request, next) {
  return answerQuestion(ctx, this, request, next, registerPendingInteraction)
})
```

`answerQuestion` (`index.ts:59-89`) создаёт `PendingQuestion`, регистрирует его
как «pending interaction» сессии и **возвращает `pending.result`** — то есть
ответ уезжает на host как результат этого же waterfall-вызова:

```ts
// ui-user-questions/src/client/index.ts:59-88 (сокращено)
const pending = new PendingQuestion(sessionId, request.questions, request.signal)
const remove = registerPendingInteraction(pending, async () => { pending.delegate(); ... })
try { return await pending.result }
catch (error) { if (pending.isDelegation(error)) return await next(); throw error }
```

«Awaiting answer» в интерфейсе — это состояние pending-interaction:

- реестр ожиданий: `ctx.uiSession.registerPendingInteraction(precedence)`
  (`packages/client/ui-session/src/client/index.ts:304-323`), домен `question`
  объявлен в `ui-user-questions/src/client/contract/slots.ts:25-30`;
- в дереве сессий такая сессия помечается «Waiting for answer» — видно прямо в
  эталонном снимке GUI: `snapshots/web/question-composer/sidebar.expected.md:1`;
- ответ пользователя разрешает `pending.result` (`slots.ts:109-180`,
  `delegate()`/`isDelegation()` — на случай, если вопрос «уводят» на другой
  канал).

### 1.6. Как ответ возвращается в модель

Путь целиком **[код]**:

1. `QuestionComposer` собирает `AskUserQuestionAnswer` → `PendingQuestion.result`.
2. Значение возвращается из клиентского слушателя `ctx.remote.$on(...)` и
   `gateway/src/index.ts:520-543` (`receiveRemoteEventResult`) превращает его в
   `{kind:'result', value}` → `settleRemoteEvent`.
3. Мост `forwardWaterfall` (`packages/api/remotes/src/index.ts:138-160`) —
   `pending.source.resolve(outcome)`, то есть промис слушателя разрешается
   значением.
4. Waterfall возвращает это значение в `ask()` → инструмент рендерит JSON
   (`tool-ask-user/src/index.ts:92-98`) → обычный tool-result в логе.

Никакого отдельного RPC «submit answer» не существует: **ответ = возвращаемое
значение waterfall-слушателя** **[код]**.

> **Проверено в коде.** Схемы, имена, порядок вызовов, коды ошибок, форма
> возврата — прочитаны. **Требует эксперимента:** как выглядит панель при
> нескольких одновременных вопросах из разных сессий и что именно показывает
> GUI, если вопрос отменён хостом (снимки в `snapshots/web/question-composer/`
> покрывают только одиночный сценарий).

---

## 2. Где host-плагин может перехватить вопрос

### 2.1. Главная точка: waterfall `user-questions/request`

Объявление события (`packages/interaction/user-questions/src/types.ts:76-90`):

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'user-questions/request'(
      this: Scoped<Agent>,
      request: AskUserQuestionRequestEvent,
      next: () => Promise<AskUserQuestionAnswer>,
    ): Promise<AskUserQuestionAnswer>
  }
}
```

Строка в каталоге событий: `docs/subsystems/user-questions.md:160-172`;
`docs/event-producer-consumer.md:67` помечает его как `waterfall`, потребитель —
`user-questions`, транспорт — `remotes`.

Подписка:

```js
ctx.on('user-questions/request', async (request, next) => {
  // request.questions[], request.agent?, request.signal?
  // вернуть AskUserQuestionAnswer — «забрать» вопрос; вернуть next() — передать дальше
})
```

Диспетчеризация **scope-фильтруется** по `agent`:
`packages/core/scope/src/scoped-events.generated.ts:37`
(`'user-questions/request': args => args[0]['agent']`). Слушатель на обычном
(не агентском) контексте получает запросы всех агентов **[код]**.

### 2.2. Порядок в waterfall — критичен, и он НЕ в вашу пользу

`waterfall` в Cordis вызывает слушателей в порядке регистрации, «outermost-first»
(`vendor/cordis/src/events.ts:234-243`). Слушатель `api-remotes`, который
отправляет вопрос браузеру, регистрируется при монтировании ряда `api-remotes`
(`packages/bundle/web-app/cordis.patch.yml:166-167`), то есть **раньше** любого
плагина, добавленного позже в профиль. Значит плагин по умолчанию оказывается
**внутри** цепочки и вызывается только если браузер вызвал `next()` **[код]**.

Это подтверждает и архитектурная заметка: «The original `approval/request` and
`user-questions/request` events are forwardable waterfalls. If an Agent-scoped
Client listener claims a request, it returns directly. If all delivered Clients
call `next()`, the original Cordis waterfall continues to later Host listeners.
Session control neither stores nor replays these requests.»
— `.agents/notes/implemented/architecture/2026-08-18-session-history-and-event-transport.md:210`.

**Вывод: чтобы перехватывать вопрос раньше GUI, слушатель надо ставить с
`prepend: true`.**

```ts
// vendor/cordis/src/events.ts:288-296 — опции слушателя
on(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions)
// vendor/cordis/src/events.ts:254-258 — размещение
register(label, hooks, callback, options) {
  const method = options.prepend ? 'unshift' : 'push'
```

Что `prepend` реально значит, видно по комментарию в сервисе approvals — там
ровно этот же сценарий оспаривается:

> «The 'never' policy is decided HERE, before any dispatch: a listener registered
> with `prepend: true` after this service mounts would sit ahead of any gate
> LISTENER, so a listener-shaped gate cannot keep the documented promise…»
> — `packages/interaction/user-approval/src/index.ts:272-276`

То есть разработчики DSH считают `prepend`-слушатель «стоящим впереди прочих
гейтов». **[код]**

> **Требует эксперимента:** фактический порядок монтирования ряда плагина
> относительно `api-remotes` в конкретном профиле (зависит от `inject`-графа:
> ряд, у которого зависимости готовы раньше, может зарегистрировать слушатель
> раньше). Поэтому `prepend: true` нужно ставить **всегда**, а не «для
> надёжности».

### 2.3. Что будет, если «забрать» вопрос, не позвав `next()`

Слушатель, вернувший значение, не запускает следующий — значит мост
`api-remotes` не вызывается вовсе, remote-событие не создаётся, браузер ничего
не увидит. Это чистый режим «вопрос ушёл в мессенджер» **[код]**.

А вот обратный сценарий (позвать `next()`, а потом вернуть свой ответ раньше
браузера) **опасен**: мост уже положил кадр в очередь и создал pending-событие в
Gateway (`packages/api/gateway/src/index.ts:457-520`), и снять его можно только
через `cancelRemoteEvent` — а он срабатывает лишь по аборту `signal` запроса или
по освобождению контекста агента (`gateway/src/index.ts:486-509`, `564-572`).
Аборт `signal` = аборт самого tool-call. Итог: панель в браузере останется
висеть, а `ask()` уже вернулся. **Правильный вывод: не «гонять» два канала
одновременно, а выбирать режим до вызова `next()`** **[код + логика]**.

Важное уточнение про «отдать GUI, если мессенджер недоступен»: `next()` можно
позвать **в любой момент до возврата** из слушателя — в том числе через 5–10
секунд, после неудачной попытки отправить вопрос. Это законно и как раз даёт
нужное поведение: вопрос появится в браузере с задержкой, но появится. Что
необратимо — это уже сделанный `next()`: снять доставленный в GUI вопрос из
плагина нельзя **[код]**.

Одно следствие, которое стоит держать в голове: если вызвать `next()` после
аборта `request.signal`, мост всё равно создаст событие, а `ask()` уже завершится
ошибкой `ASK_ABORTED` — то есть «поздний» `next()` после отмены бесполезен, и
вызывать его надо только при живом `signal` **[код + логика]**, **[эксперимент]**.

Полезная деталь на будущее: pending-события **доигрываются** новому клиенту —
при подключении браузера Gateway рассылает ему все незавершённые события
(`gateway/src/index.ts:419`: `for (const pending of this.pendingRemoteEvents.values()) this.deliverRemoteEvent(pending, client)`).
То есть вопрос, заданный при закрытом браузере, всплывёт в GUI, когда тот
откроется **[код]**.

### 2.4. Хуки инструментов (middleware)

Если перехватывать не waterfall, а сам вызов инструмента, есть четыре хука
`ctx.tools` (`packages/core/tools/src/index.ts:134-199`):

```ts
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>   // :144
'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>  // :155
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>  // :167
'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined            // :189
```

- `pre-execute` умеет только `allow | deny | ask` (`index.ts:573-600`,
  `PreToolDecision`) — подменить результат им нельзя.
- `execute` — «around-dispatch»: обёртка может **не звать `next()`** и вернуть
  свой `ToolExecutionResult` (`index.ts:1560-1567`:
  `this.ctx.waterfall(carrier, 'tools/execute', mutableExec, () => this.dispatchToolBody(mutableExec))`).
  Форма результата — `ToolExecutionSuccess { isError:false, value, content }` /
  `ToolExecutionFailure { isError:true, error, content }`
  (`packages/core/tools/src/index.ts:545-573`). Это рабочий способ **заменить
  поведение `ask_user_question` целиком**, не трогая пакет.
- `post-execute` умеет `accept` с заменой `content`/`value` — то есть подменить
  ответ уже после того, как он получен.

Все четыре события scope-фильтруются по `exec.agent`
(`packages/core/scope/src/scoped-events.generated.ts:33-37`).

### 2.5. Подмена/декорирование самого инструмента

- `ctx.tools.register()` — «Scoped tools shadow globals; duplicates within one
  layer and the reserved `run_code` name fail» (`packages/core/tools/src/index.ts:1024-1051`).
  Значит: **в том же слое** зарегистрировать второй `ask_user_question` нельзя
  (падение), но **на агентском контексте** (`agent.ctx`, см.
  `packages/core/agent/src/runtime-types.ts:81-82` — «Agent-scoped context; its
  contributions are agent-local») инструмент с тем же именем **затенит**
  глобальный. Это законный способ «включить удалённое управление для избранных
  сессий».
- Свой инструмент, который сам зовёт `ctx.userQuestions.ask({questions, agent, signal})`,
  — образец: `packages/plan/plan-mode/src/index.ts:293-320`.

### 2.6. Программная отправка ответа в сессию

Отдельного «submitAnswer» в DSH нет. Есть три пути, и они не эквивалентны
**[код]**:

| Что нужно | API | Что произойдёт |
|---|---|---|
| Вернуть ответ на вопрос | вернуть `AskUserQuestionAnswer` из слушателя `user-questions/request` | tool-result уходит модели, turn продолжается |
| Положить сообщение в сессию | `ctx.sessionController.prompt({requestId, sessionId, mode:'queue'|'steer', content}, signal)` | durable user-сообщение; `queue` = `agent.followup()`, `steer` = `agent.steer()` (`packages/api/session-controller/src/commands.ts:303-325`) |
| Сказать агенту напрямую | `agent.followup(msg)` / `agent.steer(msg)` (`packages/core/agent/src/runtime-types.ts:130,139`) | то же, но **без** проверки модели/маршрута и без `requestId`; в плагине лучше не использовать |

Резюме: **ответ на вопрос нельзя «влить» в уже заданный вопрос** — можно только
вернуть его из своего слушателя. Если вопрос уже забрал GUI, единственный
цивилизованный способ — отправить текст ответа отдельным сообщением (`steer`),
и модель прочитает его как реплику человека, а не как tool-result.

> **Проверено в коде:** набор хуков, их сигнатуры, семантика `prepend`, поведение
> `tools/execute`. **Требует эксперимента:** (1) реальный порядок слушателей в
> живом профиле; (2) что происходит с панелью GUI, если хост вернул ответ из
> `prepend`-слушателя, не звав `next()` (по коду — ничего не должно происходить,
> но это стоит увидеть); (3) затенит ли `agent.ctx.tools.register` глобальный
> `ask_user_question` без предупреждений в логе.

---

## 3. Как host-плагин программно доставляет сообщение в сессию

### 3.1. Чем пользуется сторож dsh-kanban

```js
// dsh-kanban/lib/index.js:75
export const inject = ["sessionController", "agentPresets"];
```

```js
// dsh-kanban/lib/index.js:651-683 (сокращено)
const deliver = async (item) => {
  const service = ctx.sessionController;
  if (!service || typeof service.prompt !== "function") { ...; return false }
  const controller = new AbortController();
  controllers.add(controller);
  await service.prompt(
    {
      requestId: randomUUID(),
      sessionId: item.sessionId,
      mode: "queue",
      content: [{ type: "text", text: noticeText(item) }],
    },
    controller.signal,
  );
};
```

Это ровно тот же путь, которым GUI кладёт сообщение в чат: сервис
`sessionController`, метод `prompt`, режим `queue` («занятая сессия его не
теряет») — так это и описано в шапке плагина (`dsh-kanban/lib/index.js:9-11`).

### 3.2. Что это за API в исходниках DSH

Сервис: `ctx.sessionController` — `SessionController`
(`packages/api/session-controller/src/index.ts:115`), Host-половина Remote-пространства
`session`.

```ts
// packages/api/session-controller/src/index.ts:315-325
@Remote('prompt')
prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
  signal.throwIfAborted()
  return this.commands.prompt(request)
}
```

```ts
// packages/api/session-controller/src/types.ts:301-314
export interface SessionPromptRequest {
  readonly requestId: SessionRequestId      // client-minted identity, пишется в лог
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}
export interface SessionPromptValue { readonly accepted: true }
```

Реализация (`packages/api/session-controller/src/commands.ts:283-336`):
резолвит агента, проверяет, что выбранной модели назначен адаптер (иначе
`session/model-unavailable`), собирает durable user-сообщение и делает
`agent.steer(message)` для `steer` либо `agent.followup(message)` для `queue`
(`commands.ts:324-325`).

Ключевое следствие: **`prompt` умеет поднимать холодную сессию.** `resolveAgent`
в отсутствие живого агента идёт в `resume` (`packages/api/session-controller/src/agent.ts:165-205`,
`:393-428` — `ctx.agents.resume({resumeSessionId, ...})`). То есть наряд можно
отправить сессии, которая не активна, — она будет восстановлена **[код]**.

Из клиента то же самое доступно как `ctx.remote.session.prompt(...)`; типовой
вызов из UI — `packages/api/session-controller/src/client/sessions/session.ts`
(пространство `session`). Для плагина важнее host-путь: `ctx.sessionController`
**[код]**.

### 3.3. Что ещё есть у `sessionController` (пригодится)

`packages/api/session-controller/src/index.ts` — Remote-методы `create`, `list`,
`history`, `follow`, `control`, `prompt`, `updateQueue` (:342), `cancel` (:352),
`fork` (:310), `rename` (:300), `attachment` (:332), `openWorkspacePath`,
`selectModel`. События `api-session/status`, `api-session/added|removed`,
`api-session/activity`, `api-session/error` (`index.ts:136-149`) — по ним удобно
понимать, занята ли сессия **[код]**.

### 3.4. Свой host-канал плагина (Remote-сервис)

dsh-kanban заводит собственный endpoint для команд из GUI: служба
`kanbanCardActions` с методами `assign`/`unassign`
(`dsh-kanban/lib/card-actions.js:494-500`):

```js
export function registerCardActionsService(ctx, options) {
  const actions = createCardActions(options);
  const service = new CardActionsService(actions);
  service.typertRemote = Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: NAMESPACE });
  const dispose = ctx.provide(SERVICE_KEY, service);
  return { service, dispose };
}
```

Рантайм-маркер `typertRemote = { service, serviceKey, namespace }` + дескриптор
методов — этого достаточно, чтобы Gateway увидел методы в режиме SRC («fallback
для endpoints без сгенерированных схем»), без пакета `@deepseek-ai/dsh-typert-protocol`
(обоснование и грабли — в шапке `card-actions.js:1-60`) **[код]**. Тот же приём
годится, если понадобится кнопка «подключиться к удалённому управлению» в GUI,
но для этой задачи достаточно команды (§4).

---

## 4. Команды человека (слэш-команды) vs инструменты модели

### 4.1. Механизм

Пакет `@deepseek-ai/dsh-commands`, сервис `ctx.commands` — `CommandRuntime`
(`packages/interaction/commands/src/index.ts:251`).

```ts
// packages/interaction/commands/src/index.ts:265-278
/**
 * Register a global or calling-agent-scoped command.
 */
register(definition: CommandDefinition): () => void {
  const registered = normalizeDefinition(definition)
  return this.layers.effect(this.ctx, layer => layer.commands.insert(registered.definition.name, registered), ...)
}
```

Определение (`packages/interaction/commands/src/types.ts:48-70`, развёрнуто в
`docs/subsystems/commands.md:30-60`):

```ts
interface CommandDefinition {
  readonly name: string                 // без слэша, lower-case
  readonly description: string
  readonly input?: { hint: string; images?: boolean }
  readonly recordInput?: boolean        // по умолчанию true
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}
interface CommandInvocation {
  commandId: CommandId; agent: Agent; rawInput: string
  attachments: readonly ImageBlock[]; signal: AbortSignal
}
type CommandResult = { kind:'success'; text?: string } | { kind:'error'; text: string }
```

Регистрация «на агент»: определения, зарегистрированные через **дочерний контекст
агента**, затеняют глобальные для этого агента
(`packages/interaction/commands/src/index.ts:246-250`). Пример живой команды:
`packages/goal/command-goal/src/index.ts:190`; команда, читающая аргументы и
меняющая режим: `packages/plan/plan-mode/src/index.ts:225-266`.

### 4.2. Как человек её вызывает

GUI превращает `/` в источник подсказок и отправляет строку на host **[код]**:

```ts
// packages/client/ui-commands/src/client/service.ts:51
export const inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands', 'locale']
// :142 — каталог команд для сессии
const result = await ctx.remote.commands.list(sessionId)
// :405 — исполнение строки
const result = await this.ctx.remote.commands.execute(session.sessionId, line, images)
```

На host это `commands/execute` → `CommandRuntime.execute(agent, line, images, signal)`
(`commands/src/index.ts:330-345`): парсит строку, находит команду, пишет в лог
`command/run` **до** вызова handler'а и `command/done` после
(`index.ts:305-330`). **Команда не создаёт сообщение модели и не является
tool-call** — это прямой вызов handler'а с последующей записью двух событий в
лог. Смена состава команд публикуется событием `commands/change`
(`types.ts:73-80`), оно форвардится клиентам
(`packages/api/remotes/src/remote-events.ts:24`).

### 4.3. Отличие от инструмента

| | инструмент (`ctx.tools`) | команда (`ctx.commands`) |
|---|---|---|
| Кто вызывает | модель | человек (через GUI) |
| Виден модели | да (в схеме инструментов) | нет |
| Аргументы | JSON по схеме | свободный текст `rawInput` после имени |
| Результат | tool-result в контексте модели | результат в UI + `command/run`/`command/done` в лог |
| Область | глобально или per-agent (затенение) | глобально или per-agent (затенение) |
| Где объявлено | `packages/core/tools/src/index.ts:1024` | `packages/interaction/commands/src/index.ts:265` |

Вывод для задачи: **«подключиться к удалённому управлению», «привязать чат»,
«показать статус» — это команды** (человек их вызывает, модель не должна), а
вопросы агенту остаются инструментом **[код]**.

> **Проверено в коде.** **Требует эксперимента:** как ведёт себя composer, если
> команда с таким именем зарегистрирована и глобально, и на агенте (по коду
> побеждает агентская), и обновляется ли popup-список без перезагрузки страницы
> после `commands/change` (событие форвардится, инвалидация в
> `ui-commands/src/client/service.ts:159`).

---

## 5. Конфиг плагина и патч-слой профиля

### 5.1. Как плагин получает конфиг

Форма плагина и валидация (`vendor/cordis/src/registry.ts:100-120`):

```ts
export interface Base<T = any> {
  name?: string
  Config?: StandardSchemaV1<any, T>   // схема (на практике @deepseek-ai/schemastery z.object)
  inject?: Inject
  provide?: string | string[]
}
export interface Object<T = any> { apply(ctx: Context, config: T): any }
```

Конфиг приходит **вторым аргументом** `apply(ctx, config)` / конструктора
`new (ctx, config)`; в подклассе `Service` его обычно принимают как
`constructor(ctx, public config: Config)` и объявляют схему рядом
(`packages/credentials/credentials-local/src/index.ts:517` — `static Config: z<Config> = z.object({...})`,
`:550` — конструктор). Отдельного `ctx.config` в Cordis нет — значение живёт в
fiber'е (`vendor/cordis/src/fiber.ts:253`:
`new runtime.callback(this.ctx, this.config)`).
`!!js`-выражения в конфиге ряда разворачивает Loader:
`vendor/loader/src/index.ts:96-100` (`interpolate(this.ctx, config)`) **[код]**.

### 5.2. Слои патчей и порядок

Полный порядок композиции (`apps/cli/src/profile-boot.ts:136-145`, `:151-172`):

```
bundle-слои (в порядке dsh.profile.bundles)  →  ~/.dsh/profiles/<name>/cordis.patch.yml
  →  ~/.dsh/cordis.patch.yml (home-level, главнее профильного)  →  --patch оверлеи
  →  телеметрийный переключатель
```

`allPatches()` — `apps/cli/src/profile-boot.ts:140-147`; live-пересборка
перечитывает оба пользовательских файла на каждое поколение — `:245-250`.

### 5.3. Семантика патча (точный формат)

`vendor/include/src/index.ts:145-155`:

```ts
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

Алгоритм — `applyEntryPatches` (`vendor/include/src/index.ts:58-125`):

- `insert` **без** `id` — добавить ряды в конец корневого списка (`:93-95`);
- `insert` **с** `id` — вложить ряды в `config` группы с этим id; если ряда нет
  или он не группа — warning и пропуск (`:80-92`);
- патч **с** `id` без `insert` — «id-targeted override»: для каждого ключа, кроме
  `id`, `target[key] = value` (`:105-125`). **`config` заменяется целиком**, а не
  мержится — поэтому «restating the fields you keep» (README:
  `packages/boot/app-boot/README.md:53`);
- `name` в патче — это **проверка**, а не переименование: при несовпадении с
  фактическим `name` ряда патч пропускается с warning (`:114-118`);
- вставленные ряды индексируются, поэтому **следующий** патч в том же списке уже
  может на них ссылаться (`:96-102`);
- патч, не нашедший ряд, печатает warning и пропускается; пустой файл или файл
  из одних комментариев **валит boot** — отключать надо через `[]`
  (`packages/boot/app-boot/README.md:53`).

### 5.4. Как ставится плагин и как выглядит его ряд

`dsh plugin --profile <name> add <package|path>` — тонкая обёртка над pnpm:
инициализирует профиль, запускает `pnpm`, затем **сверяет `dsh.profile.bundles`
с установленным состоянием**: зависимость, чей `package.json` объявляет
`dsh.bundle`, добавляется в список слоёв; исчезнувшая — убирается
(`apps/cli/src/plugin.ts:1-15`, `:44-92`). Bundle-less зависимость ставится как
обычная и получает warning **[код]**.

Свой ряд плагин объявляет у себя:

```jsonc
// dsh-kanban/package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" },
         "client": { "platform": "web", "inject": [ ... ] } }
```

```yaml
# dsh-kanban/cordis.patch.yml
- insert:
    - id: ui-kanban
      name: 'dsh-kanban'
      config:
        boards: [ '!!js process.env.HOME + ...' ]
```

### 5.5. Как добавить СВОЙ ряд в патч-слой ПРОФИЛЯ (не правя пакет)

Файл: `~/.dsh/profiles/web/cordis.patch.yml` (имя файла —
`PROFILE_PATCH_FILENAME` в `packages/boot/app-boot/src/profile.ts:44`).

**A. Переопределить конфиг уже существующего ряда** (например, ряда плагина,
приехавшего из его bundle-слоя) — по `id`, с полным повторением сохраняемых полей:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: ui-kanban
  name: 'dsh-kanban'          # необязательная, но полезная проверка «тот ли ряд»
  config:                     # ЗАМЕНЯЕТСЯ ЦЕЛИКОМ
    boards:
      - /Users/victor/projects/dsh-kanban
    roots:
      - /Users/victor/projects/ai-fabric/aif-project
    debounceMs: 400
    catchUpMs: 2000
```

Проверено по `vendor/include/src/index.ts:105-125`: ключи, которых нет в патче,
**не** сохраняются автоматически — `config` переписывается объектом целиком.

**B. Вставить новый ряд в корень дерева** (свой плагин, не устанавливая его как
bundle):

```yaml
- insert:
    - id: dispatcher-telegram
      name: '/Users/victor/projects/dsh-dispatcher/plugin'   # абсолютный путь или имя пакета
      config:
        enabled: true
        credentialRef: TELEGRAM_BOT_TOKEN
```

Относительные пути в `insert` разрешаются от каталога **файла патча**
(`anchorInsertedPluginNames`, `packages/boot/app-boot/src/index.ts:310-321`) —
поэтому надёжнее абсолютный путь.

**C. Вложить ряд в существующую группу** (если ряд-группа есть):

```yaml
- id: <group-row-id>
  insert:
    - id: my-row
      name: 'my-plugin'
```

**D. Выключить ряд:** `- id: <row-id>\n  disabled: true` (`PatchOptions.disabled`,
`vendor/include/src/index.ts:150`).

**E. Hot-reload:** профиль `web` объявлен с `patchReload: live`
(`packages/boot/app-boot/src/profile.ts:143-144`), и тогда оба пользовательских
файла watched: «a valid edit recomposes without restart, while a rejected edit
leaves the last good app running» (`packages/boot/app-boot/README.md:55`;
реализация — `apps/cli/src/profile-boot.ts:290-300`, где при отсутствии `hmr`
монтируется watch-only экземпляр).

> **Проверено в коде:** порядок слоёв, семантика `insert`/`id`/`name`/`disabled`,
> замена конфига целиком, watcher. **Требует эксперимента:** (1) виден ли
> live-reload нового ряда без рестарта приложения (в заметках сказано, что
> модульный HMR в поставляемых профилях выключен — перезагрузка именно *конфига*
> работает, а замена *кода* плагина нет:
> `.agents/notes/implemented/architecture/2026-08-22-single-dsh-application-launcher.md:35`);
> (2) как ведёт себя `dsh --dump-config` с нашим патчем (быстрая проверка
> «патч нашёл ряд»).

---

## 6. Секреты: штатное хранилище и как им пользоваться

### 6.1. Хранилище есть

Файловый провайдер — `@deepseek-ai/dsh-credentials-local`, документ
`$DSH_HOME/.credentials.yaml` (`packages/credentials/credentials-local/src/index.ts:1-30`,
константа `CREDENTIALS_FILENAME` — `:61`). Слои и приоритет (`:7-11`, реализация
`:619-637`):

```
inherited process environment   (только чтение, побеждает)
> $DSH_HOME/.credentials.yaml   (управляется провайдером, writable)
> <cwd>/.env                    (read-only fallback)
> $DSH_HOME/.env                (read-only fallback)
```

Файл — строгое отображение `CredentialRef → string` (не dotenv): «The document
holds nothing but credentials» (`:24-30`). Запись идёт под межпроцессным
локом, с сохранением комментариев и форматирования чужих ключей (`:23-27`).

### 6.2. API плагина

Сервис `ctx.credentials` — `CredentialProvider`
(`packages/credentials/credentials/src/index.ts:170-210`):

```ts
abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>  // :183
abstract describe(ref: CredentialRef): Promise<CredentialInfo>                 // :191
abstract set(ref: CredentialRef, value: string): Promise<void>                 // :201
abstract unset(ref: CredentialRef): Promise<void>                              // :209
```

`CredentialRef` — POSIX-имя переменной окружения, строится через
`credentialRef('TELEGRAM_BOT_TOKEN')` (`credentials/src/index.ts:29-34`).
`resolve` возвращает `{ value, source }`; `describe` — `{ configured, source?,
writable }` без значения (можно отдавать в UI). Резолв — **на каждую операцию**,
кэшировать нельзя: это и есть механизм «ротация без рестарта» (`:175-183`).

Событие изменения: `credentials/reference-updated (ref)`
(`docs/subsystems/credentials.md`, раздел «Change commits»); оно форвардится
клиенту (`packages/api/remotes/src/remote-events.ts:25`).

### 6.3. Как правильно хранить токен бота

1. В конфиге ряда плагина хранится **ссылка**, а не токен:
   `config: { credentialRef: TELEGRAM_BOT_TOKEN }`.
2. Значение — в `~/.dsh/.credentials.yaml` (или через
   `ctx.credentials.set(credentialRef('TELEGRAM_BOT_TOKEN'), token)` из команды
   `/telegram token <...>`).
3. Осторожно с приоритетом: если `TELEGRAM_BOT_TOKEN` экспортирован в окружении,
   он победит файл, а `describe().writable` вернёт `false`
   (`credentials-local/src/index.ts:619-637`) — UI должен показать это как
   read-only, иначе запись «как бы» пройдёт, а резолв продолжит отдавать
   окружение **[код]**.

> **Проверено в коде:** путь файла, слои, API, событие. **Требует
> эксперимента:** поведение `.credentials.yaml` при параллельной записи из двух
> экземпляров DSH (есть file-lock, но конкретный сценарий не проверялся);
> отображение ссылки в готовых экранах настроек (`ui-settings-models`).

---

## 7. Ограничения: сеть, песочница, таймауты, выключенное приложение

### 7.1. Сеть: host-половине HTTP разрешён

Песочница DSH описывает **только файловые эффекты**: «`SandboxMode` governs
filesystem effects only… **Network and process visibility are outside this
vocabulary**» (`docs/subsystems/sandbox.md:11`). Провайдеры (`sandbox-local`,
`-windows-acl`) оборачивают **порождённые процессы** инструментов, а не код
плагина.

Следствие: host-половина плагина исполняется в процессе DSH (Node) и может
делать исходящий HTTP (`fetch`/`undici`) без каких-либо политик DSH **[код]**
(сам факт отсутствия сетевой политики; конкретный сетевой вызов — [эксперимент]).

Если понадобится **входящий** HTTP (webhook от мессенджера), у плагина есть
штатная точка:

```ts
// packages/host/webserver/src/index.ts:165-176
register(route: WebRoute): () => void        // дубликат (kind,path) → throw
// WebRoute: { kind: 'exact' | 'prefix', path, handler(req,res) }  — :42-48
```

Сервер монтируется рядом `webserver` с `host: !!js ctx.webStartup.host ?? '127.0.0.1'`,
`port: 3080` (`packages/bundle/web-app/cordis.patch.yml:111-118`). То есть по
умолчанию он слушает loopback — для webhook нужен `--host 0.0.0.0`/туннель и
**своя** аутентификация маршрута. Для ноутбука за NAT проще long polling
(транспортная часть — в `docs/research/messengers.md`).

### 7.2. Таймауты

- Общий «кооперативный» дедлайн инструмента — `ToolDefinition.timeoutMs`
  (`packages/core/tools/src/index.ts:238-247`): «Omit for no deadline… Enforced by
  `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper)».
  Плагин `dsh-tool-call-timeout-policy` включён в base-бандл и не имеет своей
  конфигурации: лимит берётся из конфига каждого инструмента
  (`packages/guard/timeout-policy/README.md`, «Use this package»).
- У `ask_user_question` `timeoutMs` **не объявлен** (`tool-ask-user/src/index.ts:20-100`)
  → **дефолтного таймаута на вопрос нет**: агент ждёт, пока ответят, отменят или
  оборвётся `exec.signal` **[код]**.
- Для сравнения: `web_fetch`/`web_search` ограничены 30 000 мс
  (`packages/web/tool-web/src/index.ts:59-60`).

**Вывод для интеграции: таймаут «человек не ответил N минут» придётся
реализовывать самому** (гонка с таймером внутри своего слушателя), иначе
повисший вопрос держит turn бесконечно.

### 7.3. Что будет при закрытом приложении / выключенном DSH

- Плагин живёт в процессе DSH: нет процесса — нет ни перехвата, ни доставки.
  Внешний мессенджер в этот момент не получит ничего, и «ответить» будет некуда
  **[код + логика]**.
- Вопросы **не персистятся**: «Session control neither stores nor replays these
  requests» (`.agents/notes/.../2026-08-18-session-history-and-event-transport.md:210`).
  То есть после падения процесса незавершённый вопрос исчезает; инструмент уже
  упал (или упадёт по аборту), в логе останется tool-result с ошибкой.
- Сессия, которой шлют сообщение, **поднимается из лога** при `prompt`
  (`packages/api/session-controller/src/agent.ts:393-428`), но только пока жив
  процесс DSH.
- Закрытый браузер проблемой не является: pending-события доигрываются новому
  клиенту (`gateway/src/index.ts:419`).

> **Проверено в коде:** отсутствие сетевой политики, наличие/отсутствие
> таймаутов, API маршрутов, семантика resume, доигрывание pending-событий.
> **Требует эксперимента:** переживает ли `AbortController` отмену turn'а так,
> как ожидается (в kanban это используется — `lib/index.js:646-682`), и что
> именно видит модель, если вопрос отменён абортом.

---

## 8. GUI: уведомления, тосты, правая колонка (куда вешать настройки)

### 8.1. Что есть в этом чекауте

Слоты каркаса объявлены в `packages/client/ui-layout/src/client/index.ts:36-86`:

| слот | тип | смысл |
|---|---|---|
| `sidebar` (:52) | single/root | вся левая колонка (занята `ui-sidebar`) |
| `conversation` (:63) | single/session-maybe | центральная колонка |
| `details` (:75) | single/session | **правая колонка деталей**; занята `DetailsPanel` из `ui-conversation`, при отсутствии владельца пуста |
| `shell.overlay` (:86) | list/root | плавающий слой над всем каркасом: «a badge, a toast stack or a status pill all belong here» |

Рендер: `packages/client/ui-layout/src/client/AppFrame.tsx:207` (`details`),
`:211` (`shell.overlay`). Вкладки в центральной части — слот `conversation.view`
(`packages/client/ui-conversation/src/client/contract/slots.ts:117`,
реестр вкладок собирается в `ui-conversation/src/client/apply.ts:120-133`;
пример регистрации — `packages/client/ui-trajectory/src/client/index.ts:77-90`).
Строка настроек — `settings.general.item` (пример:
`packages/client/ui-conversation/src/client/apply.ts:109-116`).

### 8.2. Тосты

Сервиса-нотификатора нет; есть компонент `Toast`
(`packages/client/ui-primitives/src/Toast.tsx:1-25`): «Transient top-center
banner… the owner passes localized text», держится 3 с, затем 1 с fade, и зовёт
`onDone` — владелец размонтирует. Владелец сам решает, где его рендерить; для
общесистемных баннеров есть `shell.overlay` **[код]**.

### 8.3. Важное расхождение: `sidebarRightTabs` в этом чекауте НЕТ

Клиентская половина dsh-kanban инжектит сервис `sidebarRightTabs` и регистрирует
типы вкладок правого сайдбара:

```js
// dsh-kanban/lib/client.js:1731, 1740-1758, 1770-1798
const inject = ["slots", "locale", "sidebarRightTabs", "remote", "remote.workspaceFiles", "connection"];
ctx.sidebarRightTabs.register({ id: ID, kind: KIND, priority: "extension", title: () => t("title"), guide: [...] })
ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: ID, ... }, KanbanBody))
```

В чекауте `0.1.2-alpha.2` **нет ни сервиса `sidebarRightTabs`, ни слотов
`sidebar.right.*`** — поиск по всем `.ts/.tsx/.md` не даёт ни одного вхождения,
а правый столбец называется `details` (§8.1). Значит клиентская половина
dsh-kanban написана против **другой (более новой) сборки DSH**, чем лежит в
`~/projects/deepseek-harness` **[код]**.

Практический вывод: код kanban нельзя считать эталоном API для UI-части;
эталоном в этом чекауте являются `conversation.view`, `details`, `shell.overlay`,
`settings.general.item`. Перед реализацией UI стоит сверить API с той сборкой,
которая реально запущена (`/Applications/DeepSeek Harness.app/.../dsh`, asar —
грепом не проверяется, нужен запуск) — **[эксперимент]**.

---

## 9. Минимальный дизайн интеграции

Задача: вопрос агента уходит в мессенджер, ответ человека возвращается в сессию.
Транспорт (Telegram/MAX, кнопки, long polling) — в `docs/research/messengers.md`;
ниже только DSH-часть. Терминология и требования — `docs/CONCEPT.md` (§4.1
«`dsh-remote` (host-плагин)») и `.kanban/specs/001.md` (требования 1, 3, 7, 8).

### 9.1. Состав плагина

```
dsh-remote/
  package.json      # dsh.bundle.patch → ./cordis.patch.yml (+ dsh.client, если будет GUI-часть)
  cordis.patch.yml  # - insert: [ { id: dsh-remote, name: '<path>', config: { credentialRef: TELEGRAM_BOT_TOKEN, ... } } ]
  lib/index.js      # host: перехват → транспорт → ответ; команды /remote ...
  lib/transports/   # fake / telegram / max
  test/             # node --test, без сети
```

Состояние и привязки — `~/.dsh/remote-control/` (вне репозитория), как в
`AGENTS.md`. Ряд плагина объявляется его собственным патчем; переопределять его
конфиг — в `~/.dsh/profiles/web/cordis.patch.yml` по §5.5 (этот файл правит
человек, не агент).

### 9.2. (а) Перехват вопроса

```js
export const inject = ['credentials']            // + 'sessionController', 'commands' по мере надобности
export const name = 'dsh-remote'

export function apply(ctx, config) {
  ctx.on('user-questions/request', async (request, next) => {
    // 1) режим выключен / сессия не под удалённым управлением → как в DSH
    if (!armed(config, request)) return next()
    // 2) транспорт недоступен ПРЯМО СЕЙЧАС → отдаём GUI (next() можно звать с задержкой)
    if (!transport.healthy()) return next()
    // 3) публикуем в мессенджер и ждём ответ (с TTL!)
    return await askThroughTransport(ctx, request)      // AskUserQuestionAnswer
  }, { prepend: true })                                 // ← обязательно
}
```

- `ctx.on(..., { prepend: true })` — единственный способ оказаться **до** моста
  `api-remotes` (§2.2). Без него вопрос всегда сначала уходит в браузер.
- Не звать `next()`, когда забираем вопрос: тогда remote-событие вообще не
  создаётся и «висеть» ничего не будет (§2.3).
- Отдать GUI **после** неудачной попытки можно — `next()` зовётся в любой момент
  до возврата; но после уже сделанного `next()` забрать вопрос назад нельзя
  (§2.3). Поэтому решение «телефон или GUI» принимается по состоянию транспорта
  **до** публикации, а не после.
- Режим `mirror` (вопрос и в GUI, и в телефоне) в MVP **не реализуем** штатными
  средствами: два канала на один вопрос не согласуются (§2.3). В спеке он и
  отложен на фазу 2 — если понадобится, это отдельное исследование.
- `request.signal` — слушать: при отмене снимать сообщение из мессенджера или
  помечать его «cancelled» (kanban делает так со своими доставками —
  `dsh-kanban/lib/index.js:646-682`).
- Таймаута на вопрос в DSH нет (§7.2) — TTL 30 мин из спеки 001 реализуется
  своим таймером; по истечении возвращаем `{answers:[{id, selected:[], custom:
  '…'}]}` либо бросаем `UserQuestionError` (`ASK_ABORTED`).

### 9.3. (б) Отправка в мессенджер

- HTTP — прямо из host-половины (`fetch`), сетевой песочницы нет (§7.1).
- Токен — `ctx.credentials.resolve(credentialRef(config.credentialRef))`; в
  конфиге ряда лежит **ссылка**, не значение (§6.3). Запись токена — командой
  `/remote connect` через `ctx.credentials.set`.
- `chat_id`/allowlist, pairing-код и состояние — в `~/.dsh/remote-control/`
  (атомарная запись, chmod 600), не в конфиге ряда и не в git.
- Ключ маршрутизации ответа — свой: `id` вопроса уникален только внутри
  запроса, поэтому для нескольких сессий нужен ключ вида `sessionId + questionIds
  + метка времени` (в спеке 001 — требование 5 «несколько сессий»).
- Исходящие в мессенджер **не** идут через `sessionController.prompt` — это
  сообщение агенту, а не в мессенджер.

### 9.4. (в) Приём ответа и возврат в сессию

Два случая, и они принципиально разные:

1. **Вопрос наш** (мы его забрали): ответ = возвращаемое значение слушателя —
   `{ answers: [{ id, selected: [...], custom? }] }`. Больше ничего делать не
   нужно: `ask()` сам доедет до инструмента и модели (§1.6). `selected` должен
   содержать **метки опций как есть** (label), иначе семантика ответа разъедется;
   для multi-select `custom` дополняет `selected`, для single-select — заменяет.
2. **Вопрос ушёл в GUI** (мы позвали `next()`): вернуть ответ в тот же вопрос
   нельзя — API нет (§2.6). Единственный путь — отправить ответ отдельным
   сообщением:

```js
await ctx.sessionController.prompt({
  requestId: crypto.randomUUID(),
  sessionId,
  mode: 'steer',                    // вклиниться в текущий turn; 'queue' — в очередь
  content: [{ type: 'text', text: `Ответ человека: ${text}` }],
}, signal)
```

Тот же приём — для любых «внеплановых» указаний из мессенджера (как наряды
сторожа kanban, §3.1), включая случай, когда сессия не активна: `prompt`
поднимет её из лога (§3.2). Но помнить: это уже **не** tool-result, а реплика
человека — модель увидит её как обычное сообщение.

### 9.5. (г) Команды для человека

`ctx.commands.register({ name, description, input, handler })` (§4). По спеке
001: `/remote connect | on | off | status | test | who | disconnect | doctor`.
Имя без слэша (`remote`), аргументы — свободный `rawInput`; обработчик получает
`agent`, `attachments`, `signal` и возвращает `{kind:'success'|'error', text}`.
Команды не видны модели и не создают сообщений — ровно то, что нужно для
«подключиться к удалённому управлению». Токен и pairing — внутри `connect`
(ввод токена — локальным вопросом через `ctx.userQuestions.ask`, но уже **без**
своего перехвата: иначе плагин перехватит сам себя — проверять флагом).

### 9.6. Чего в DSH НЕТ (и не надо изобретать)

| Чего нет | Подтверждение |
|---|---|
| RPC «отправить ответ на конкретный вопрос» | ответ — только возврат из waterfall (§1.6, §2.6) |
| Снять уже доставленный в GUI вопрос из host-плагина | `pendingRemoteEvents` приватны; снятие — только аборт `signal` запроса (§2.3) |
| Режим «и в GUI, и в телефоне» одним вопросом | забранный вопрос не доходит до моста, а доставленный — не отзывается (§2.3) |
| Персистентность/реплей вопросов | `.agents/notes/.../session-history-and-event-transport.md:210` |
| Штатный таймаут на `ask_user_question` | `timeoutMs` не объявлен (§7.2) |
| Сетевая политика для host-кода | `docs/subsystems/sandbox.md:11` |
| Сервис уведомлений/тостов | только компонент `Toast` + слот `shell.overlay` (§8.2) |
| `sidebarRightTabs` в этом чекауте | отсутствует; правый столбец — `details` (§8.3) |

### 9.7. Порядок проверки (что подтвердить до реализации)

1. `ctx.on('user-questions/request', h, { prepend: true })` действительно
   срабатывает раньше моста в живом профиле `web` — лог + вопрос из тестовой
   сессии при **открытом** браузере.
2. Забранный вопрос **не** появляется в GUI и turn продолжается с нашим ответом.
3. При выключенном режиме (`return next()`) поведение не меняется: панель в GUI
   появляется как обычно.
4. Отложенный `next()` (транспорт недоступен → отдали GUI через 2–3 с) приводит
   к появлению панели, а не к висящему turn'у.
5. `sessionController.prompt(..., 'steer')` доходит до занятой сессии и модель
   видит текст (проверить по логу сессии).
6. `ctx.credentials.resolve` возвращает токен из `~/.dsh/.credentials.yaml` и
   `describe().writable === true`.
7. `dsh --dump-config --profile web` показывает наш ряд и наш `config` (быстрая
   проверка патч-слоя, `apps/cli/src/dump-config.ts:40-43`).
8. Live-reload конфига: правка `~/.dsh/profiles/web/cordis.patch.yml` меняет
   конфиг ряда без рестарта (`apps/cli/src/profile-boot.ts:290-300`).
9. Команда `/remote connect` не перехватывает собственный вопрос про токен
   (флаг «идёт служебный вопрос»).

### 9.8. Соответствие спеке 001

| Требование `.kanban/specs/001.md` | Чем закрывается |
|---|---|
| 1. Перехват через `user-questions/request`, при выключенном — `next()` | §9.2 (`prepend: true`) |
| 2. Изоляция ядра (только публичные сервисы) | `userQuestions`-событие, `commands`, `sessionController`, `credentials` — все публичные (§2, §3, §4, §6) |
| 3. Подключение командой `/remote connect` | §9.5 |
| 4. Адресация (воркспейс, задача, роль, время, дедлайн) | `request.agent` + `agent.session.header.cwd`, `agentPreset` из `agent-presets`; время/дедлайн — свои |
| 5. Ответ кнопками/текстом, ровно один раз | §9.4 п.1; идемпотентность — на стороне плагина |
| 6. Транспорт-абстракция | вне DSH-слоя (`docs/research/messengers.md`) |
| 7. Устойчивость (TTL, недоставленный вопрос → GUI, осиротевшие → cancelled) | §2.3 (отложенный `next()`), §7.2 (своего таймаута нет) |
| 8. Безопасность (allowlist, pairing, токен — reference) | §6.3, §9.3 |
| 9. Состояние в `~/.dsh/remote-control/` | §9.1, §9.3 |
| 10. Тесты без сети | `fake`-транспорт; DSH-API в тестах мокаются через cordis-контекст |

---

## Приложение: сводка «проверено / требует эксперимента»

| № | Утверждение | Статус |
|---|---|---|
| 1 | `ask_user_question`, схемы аргументов/результата, `NO_PROVIDER`, коды ошибок | код |
| 1 | Панель вопроса подменяет композер, «Waiting for answer» в дереве | код (+ снимки GUI) |
| 1 | Ответ возвращается как значение waterfall → tool-result | код |
| 2 | `user-questions/request` — scope-фильтрованный waterfall по `agent` | код |
| 2 | Порядок слушателей = порядок регистрации; `api-remotes` раньше плагина | код |
| 2 | `prepend: true` даёт приоритет | код |
| 2 | Реальный порядок монтирования в профиле `web` | **эксперимент** |
| 2 | Замена поведения через `tools/execute` (не звать `next()`) | код |
| 3 | `sessionController.prompt({requestId, sessionId, mode, content})`, `queue`/`steer` | код |
| 3 | `prompt` поднимает холодную сессию | код |
| 3 | Свой Remote-сервис плагина (`typertRemote`-маркер, SRC-режим) | код (в kanban) + **эксперимент** в нашей сборке |
| 4 | Команды: `ctx.commands.register`, `commands/execute`, `/`-триггер в GUI | код |
| 5 | Патч: `insert`, id-override, замена `config` целиком, `name`-проверка, `disabled` | код |
| 5 | Порядок слоёв: bundles → профиль → home → `--patch` | код |
| 5 | `patchReload: live` перезагружает конфиг (но не код плагина) | код + **эксперимент** |
| 6 | `~/.dsh/.credentials.yaml`, `ctx.credentials.{resolve,describe,set,unset}` | код |
| 7 | Сеть вне песочницы; webhook через `ctx.webServer.register` | код |
| 7 | Таймаута на вопрос нет; `timeoutMs` — опция инструмента | код |
| 7 | Вопросы не персистятся; сессия поднимается по `prompt` | код |
| 8 | `details` / `shell.overlay` / `conversation.view` / `Toast` | код |
| 8 | `sidebarRightTabs` отсутствует в чекауте `0.1.2-alpha.2` | код (grep) + **эксперимент** на живой сборке |
