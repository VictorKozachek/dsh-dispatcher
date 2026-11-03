# Порядок ответчиков в waterfall `user-questions/request`

Короткий ответ: **`prepend: true` обязателен**, иначе плагин не увидит вопрос,
пока его не отдаст браузер.

## Порядок

- `waterfall` в cordis вызывает слушателей **outermost-first**: кто
  зарегистрирован раньше, тот и первый; `next()` передаёт управление следующему,
  последний `next()` уходит в `noAnswerer` (`vendor/cordis/src/events.ts:234-243`).
- `ctx.on(name, listener, options)` размещает слушатель через
  `options.prepend ? 'unshift' : 'push'` (`vendor/cordis/src/events.ts:254-258`):
  `prepend: true` ставит ответчик впереди уже зарегистрированных.
- Мост `api-remotes` (вопрос уходит браузеру) монтируется из
  `packages/bundle/web-app/cordis.patch.yml:166-167`, то есть раньше плагина
  профиля; GUI-ответчик подписан на тот же waterfall
  (`packages/client/ui-user-questions/src/client/index.ts:104`).

## Если GUI-ответчик окажется первым

Наш слушатель окажется «внутри» цепочки и вызовется только после `next()` из
браузера — то есть обычно никогда, и вопрос в мессенджер не уйдёт. Это и
закрывает `prepend: true`; подтверждение — тест
`dsh-remote/test/answerer.spec.js` → «слушатель регистрируется с prepend и
обгоняет уже зарегистрированный GUI»: GUI подписан первым, наш — после, но
запрос забирает наш слушатель (`guiCalled` остаётся `0`).

## Вернуть вопрос в GUI через `next()` после отправки — нельзя

`next()` технически можно позвать до возврата из слушателя, но мост положит кадр
в очередь Gateway (`packages/api/gateway/src/index.ts:457-520`), а снять его
можно только по аборту `request.signal` или освобождению контекста агента
(`gateway/src/index.ts:486-509, 564-572`). Панель останется висеть, а `ask()` уже
вернётся. Поэтому режим выбирается **до** `next()`: если транспорт не доставил
вопрос, `next()` зовётся до отправки в GUI (ветка «send-failed»), а не после.

Следствия: забрали вопрос — `next()` не зовём (ответ `{answers}`, remote-события
нет, `docs/research/dsh-hooks.md` §2.3); аборт `request.signal` — отклоняем
промис, и `UserQuestionService.ask` превратит это в `ASK_ABORTED`
(`packages/interaction/user-questions/src/index.ts:143-150`).
