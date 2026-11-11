/**
 * Клиентская половина плагина `dsh-remote` — таб «Удалённое управление» в правом
 * сайдбаре DSH Web.
 *
 * Формат файла: классический скрипт-обёртка `window.__ModuleLoader__.load`, как у
 * `dsh-kanban/lib/client.js`: ядро DSH материализует его лениво
 * (`factory(require)` → exports), React берётся из базовой таблицы модулей
 * оболочки. Сборщика и JSX нет — файл написан руками.
 *
 * Данные: состояние и журнал лежат на хосте, вне воркспейса, поэтому панель
 * спрашивает снимок у host-канала `remotePanel` (см. `lib/host-channel.js`) и
 * обновляет его раз в POLL_MS. Секреты и полные пути вычищает хост
 * (`lib/panel.js`), панель их не показывает даже если они туда попадут.
 *
 * Деградация: если в конкретной сборке нет сервиса `sidebarRightTabs` или
 * слотов `sidebar.right.*`, панель не регистрируется — в лог уходит честное
 * «недоступна в этой сборке», а host-канал остаётся рабочим.
 */
window.__ModuleLoader__.load({
  id: "dsh-remote",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    /** Идентификатор типа таба; он же ключ регистрации тела и заголовка. */
    const ID = "dsh-remote-panel";
    /** Дискриминатор типа: то, что называет `openTab`. */
    const KIND = "dsh-remote";
    /** Пространство имён локали. */
    const NS = "dsh-remote";
    /** Host-канал, зарегистрированный фичей panel. */
    const RPC_NAMESPACE = "remotePanel";
    /** Период опроса: host пишет файлы из bash, фид изменений их не видит. */
    const POLL_MS = 3000;

    const en = {
      title: "Remote control",
      guide: "Status of the Telegram bot, open questions and the last journal lines",
      unavailable: "Panel is not available in this DSH build: sidebar tabs API is missing",
      channelOn: "channel up",
      channelOff: "channel down",
      binding: "bot",
      bindingNone: "not connected",
      enabled: "enabled",
      enabledNone: "off",
      questions: "open questions",
      questionsNone: "no open questions",
      journal: "journal",
      journalNone: "journal is empty",
      test: "Test",
      refresh: "Refresh",
      dismiss: "Dismiss",
      readonly: "read-only in this build",
      loading: "loading…",
      offline: "host channel unavailable",
      deadline: "deadline",
      expired: "expired",
      board: "board",
      boardNone: "no board data",
      boardStale: "stuck at role",
      spend: "token spend",
      spendNone: "no token spend recorded",
      today: "today",
      week: "week",
      total: "total"
    };

    const ru = {
      title: "Удалённое управление",
      guide: "Статус Telegram-бота, открытые вопросы и последние строки журнала",
      unavailable: "Панель недоступна в этой сборке DSH: нет API табов сайдбара",
      channelOn: "канал поднят",
      channelOff: "канал не поднят",
      binding: "бот",
      bindingNone: "не привязан",
      enabled: "включено",
      enabledNone: "выключено",
      questions: "открытые вопросы",
      questionsNone: "открытых вопросов нет",
      journal: "журнал",
      journalNone: "журнал пуст",
      test: "Тест",
      refresh: "Обновить",
      dismiss: "Снять",
      readonly: "только чтение в этой сборке",
      loading: "загружаю…",
      offline: "host-канал недоступен",
      deadline: "дедлайн",
      expired: "истёк",
      board: "доска",
      boardNone: "данных доски нет",
      boardStale: "залипли у роли",
      spend: "расход токенов",
      spendNone: "расход пока не записан",
      today: "сегодня",
      week: "неделя",
      total: "всего"
    };

    /** Время в формате `ЧЧ:ММ`; нечисловое значение — прочерк. */
    function clockText(value) {
      if (!Number.isFinite(value)) return "—";
      const date = new Date(value);
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      return hours + ":" + minutes;
    }

    /**
     * Сколько осталось до дедлайна: «12 мин», «истёк» или прочерк.
     * @param deadlineAt - метка времени или null.
     * @param now - текущее время.
     */
    function deadlineText(deadlineAt, now) {
      if (!Number.isFinite(deadlineAt)) return "—";
      const left = deadlineAt - now;
      if (left <= 0) return ru.expired;
      const minutes = Math.ceil(left / 60000);
      return minutes + " мин";
    }

    /** Строки статуса для панели: без секретов и полных путей (их нет в снимке). */
    function statusLines(snapshot) {
      const status = snapshot && snapshot.status ? snapshot.status : {};
      const lines = [];
      lines.push({
        key: "channel",
        label: status.channel === true ? "channelOn" : "channelOff",
        value: status.configChannel === true ? "config" : ""
      });
      if (status.binding) {
        lines.push({
          key: "binding",
          label: "binding",
          value: String(status.binding.botUsername || status.binding.transport || "telegram")
        });
      } else {
        lines.push({ key: "binding", label: "binding", value: "bindingNone" });
      }
      const enabled = status.enabled || {};
      const scopes = [];
      if (enabled.global === true) scopes.push("все проекты");
      for (const workspace of enabled.workspaces || []) scopes.push(workspace);
      for (const session of enabled.sessions || []) scopes.push("сессия " + String(session).slice(0, 8));
      lines.push({ key: "enabled", label: "enabled", value: scopes.length > 0 ? scopes.join(", ") : "enabledNone" });
      return lines;
    }

    /** Описание ошибки из envelope RPC: текст, а не stacktrace. */
    function describeError(error) {
      if (!error) return "";
      if (typeof error === "string") return error;
      return String(error.message || error.code || "");
    }

    /**
     * Клиент host-канала: снимок, снятие вопроса, тест канала.
     * @param connection - клиентское соединение (`ctx.connection`).
     */
    function createClient(connection) {
      async function call(method, request, signal) {
        if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") {
          return { ok: false, offline: true, message: "" };
        }
        let envelope;
        try {
          envelope = await connection.rpc.call(
            "/api",
            RPC_NAMESPACE + "/" + method,
            { args: { request: request } },
            signal
          );
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
        if (!envelope || envelope.ok !== true) {
          return { ok: false, message: describeError(envelope ? envelope.error : null) };
        }
        const value = envelope.value;
        if (!value || typeof value !== "object") return { ok: false, message: "" };
        return value;
      }

      return {
        snapshot: (signal) => call("snapshot", {}, signal),
        dismiss: (shortId, signal) => call("dismiss", { shortId: shortId }, signal),
        test: (signal) => call("test", {}, signal)
      };
    }

    /** Кнопка панели: одинаковая для «Тест»/«Обновить»/«Снять». */
    function Button(props) {
      return h(
        "button",
        {
          type: "button",
          disabled: props.disabled === true,
          onClick: props.onClick,
          style: {
            padding: "2px 8px",
            borderRadius: 6,
            border: "1px solid #cbd5e1",
            background: props.primary === true ? "#0f172a" : "#f8fafc",
            color: props.primary === true ? "#f8fafc" : "#0f172a",
            cursor: props.disabled === true ? "default" : "pointer",
            fontSize: 12
          }
        },
        props.label
      );
    }

    /** Строка «метка: значение» с локализуемой меткой. */
    function Row(props) {
      return h(
        "div",
        { style: { display: "flex", gap: 6, fontSize: 12, lineHeight: "18px" } },
        h("span", { style: { color: "#64748b", minWidth: 96 } }, props.label),
        h("span", { style: { color: "#0f172a", wordBreak: "break-word" } }, props.value)
      );
    }

    /**
     * Тело таба: статус, открытые вопросы, журнал и кнопки.
     *
     * Пропсы приходят из `inject`-функции слота: `{sessionId, t, client}` —
     * так же, как у `dsh-kanban` (`props.t`, `props.sessionId`).
     */
    function PanelBody(props) {
      const t = props.t;
      const client = props.client;
      const [state, setState] = React.useState({ loading: true, error: "", snapshot: null });
      const [busy, setBusy] = React.useState("");
      const [notice, setNotice] = React.useState("");

      const load = React.useCallback(async (signal) => {
        const result = await client.snapshot(signal);
        if (!result || result.ok !== true) {
          setState({ loading: false, error: result && result.offline ? t("offline") : describeError(result ? result.message : ""), snapshot: null });
          return;
        }
        setState({ loading: false, error: "", snapshot: result });
      }, [client, t]);

      React.useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        const timer = setInterval(() => {
          void load(controller.signal);
        }, POLL_MS);
        return () => {
          clearInterval(timer);
          controller.abort();
        };
      }, [load]);

      async function run(action, shortId) {
        setBusy(action);
        setNotice("");
        try {
          const result = action === "dismiss" ? await client.dismiss(shortId) : await client.test();
          if (result && result.ok === true) {
            setNotice(action === "dismiss" ? "" : result.message || "");
            await load();
          } else if (result && result.readonly === true) {
            setNotice(result.message || t("readonly"));
          } else {
            setNotice(describeError(result ? result.message : ""));
          }
        } finally {
          setBusy("");
        }
      }

      const snapshot = state.snapshot;
      const now = snapshot && Number.isFinite(snapshot.generatedAt) ? snapshot.generatedAt : Date.now();
      const questions = snapshot ? snapshot.questions || [] : [];
      const journal = snapshot && snapshot.journal ? snapshot.journal.lines || [] : [];

      const children = [];
      children.push(
        h("div", { key: "status", style: { display: "flex", flexDirection: "column", gap: 2 } },
          state.loading
            ? h(Row, { label: "", value: t("loading") })
            : statusLines(snapshot).map((line) => h(Row, { key: line.key, label: t(line.label), value: line.value === "" ? "" : (line.label === "binding" || line.label === "enabled" ? line.value : t(line.value)) }))
        )
      );

      if (state.error !== "") {
        children.push(h("div", { key: "error", style: { color: "#b91c1c", fontSize: 12 } }, state.error));
      }

      children.push(
        h("div", { key: "actions", style: { display: "flex", gap: 6, marginTop: 8 } },
          h(Button, { label: t("test"), primary: true, disabled: busy !== "", onClick: () => void run("test") }),
          h(Button, { label: t("refresh"), disabled: busy !== "", onClick: () => void load() })
        )
      );

      if (notice !== "") {
        children.push(h("div", { key: "notice", style: { fontSize: 12, color: "#475569", marginTop: 6 } }, notice));
      }

      children.push(h("div", { key: "questions-title", style: { marginTop: 12, fontSize: 12, color: "#64748b" } }, t("questions")));
      if (questions.length === 0) {
        children.push(h("div", { key: "questions-none", style: { fontSize: 12, color: "#94a3b8" } }, t("questionsNone")));
      } else {
        for (const question of questions) {
          const title = [question.taskId ? "task " + question.taskId : "", question.role || "", question.workspace || ""]
            .filter((part) => part !== "")
            .join(" · ");
          children.push(
            h("div", { key: question.shortId, style: { border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 6px", marginTop: 4, fontSize: 12 } },
              h("div", { style: { display: "flex", justifyContent: "space-between", gap: 6 } },
                h("span", { style: { fontFamily: "monospace" } }, String(question.shortId)),
                h(Button, { label: t("dismiss"), disabled: busy !== "", onClick: () => void run("dismiss", question.shortId) })
              ),
              h("div", { style: { color: "#475569" } }, title === "" ? "—" : title),
              h("div", { style: { color: "#64748b" } }, t("deadline") + ": " + deadlineText(question.deadlineAt, now) + " (" + clockText(question.deadlineAt) + ")")
            )
          );
        }
      }

      const board = snapshot && snapshot.board ? snapshot.board : null;
      if (board !== null) {
        children.push(h("div", { key: "board-title", style: { marginTop: 12, fontSize: 12, color: "#64748b" } }, t("board")));
        const workspaces = Array.isArray(board.workspaces) ? board.workspaces : [];
        if (board.available !== true || workspaces.length === 0) {
          children.push(h("div", { key: "board-none", style: { fontSize: 12, color: "#94a3b8" } }, t("boardNone")));
        } else {
          for (const workspace of workspaces) {
            if (workspace.missing === true) {
              children.push(h("div", { key: "board-" + workspace.name, style: { fontSize: 12, color: "#94a3b8" } }, workspace.name + ": " + t("boardNone")));
              continue;
            }
            const counts = workspace.counts || {};
            const summary = Object.keys(counts).map((key) => key + " " + String(counts[key])).join(" · ");
            children.push(h("div", { key: "board-" + workspace.name, style: { fontSize: 12 } }, workspace.name + ": " + summary));
            const stale = Array.isArray(workspace.stale) ? workspace.stale : [];
            for (const card of stale) {
              children.push(h("div", { key: "stale-" + workspace.name + "-" + card.id, style: { fontSize: 11, color: "#b45309" } }, "#" + card.id + " " + card.title + " — " + card.status + " · " + String(card.ageMinutes) + " " + t("stale")));
            }
          }
        }
      }

      const spend = snapshot && snapshot.spend ? snapshot.spend : null;
      if (spend !== null) {
        children.push(h("div", { key: "spend-title", style: { marginTop: 12, fontSize: 12, color: "#64748b" } }, t("spend")));
        const tasks = Array.isArray(spend.tasks) ? spend.tasks.slice(0, 5) : [];
        if (tasks.length === 0) {
          children.push(h("div", { key: "spend-none", style: { fontSize: 12, color: "#94a3b8" } }, t("spendNone")));
        } else {
          for (const task of tasks) {
            children.push(h("div", { key: "spend-" + task.workspace + "-" + task.id, style: { fontSize: 12 } }, "#" + task.id + " " + task.title + " — " + String(task.tokens) + " " + t("spend")));
          }
        }
        children.push(h("div", { key: "spend-total", style: { fontSize: 11, color: "#64748b" } }, t("today") + ": " + String(spend.today) + " · " + t("week") + ": " + String(spend.week) + " · " + t("total") + ": " + String(spend.total)));
      }

      children.push(h("div", { key: "journal-title", style: { marginTop: 12, fontSize: 12, color: "#64748b" } }, t("journal")));
      if (journal.length === 0) {
        children.push(h("div", { key: "journal-none", style: { fontSize: 12, color: "#94a3b8" } }, t("journalNone")));
      } else {
        children.push(
          h("pre", { key: "journal", style: { margin: 0, fontSize: 11, lineHeight: "15px", whiteSpace: "pre-wrap", color: "#334155", background: "#f8fafc", borderRadius: 6, padding: 6 } },
            journal.join("\n")
          )
        );
      }

      return h("div", { style: { padding: "8px 10px", overflow: "auto", height: "100%" } }, children);
    }

    /** Заголовок таба. */
    function PanelTitle(props) {
      return h("span", null, props.t("title"));
    }

    /**
     * Сервисы Cordis, без которых `apply` не запускается.
     *
     * `sidebarRightTabs` обязателен: без внедрённого сервиса `apply` не увидит
     * `ctx.sidebarRightTabs` и панель тихо уйдёт в «недоступна». Проверка на
     * отсутствие сервиса в `apply` остаётся — но это уже защита от сборки, где
     * сервис объявлен, но не смонтирован.
     */
    const inject = ["slots", "locale", "sidebarRightTabs", "connection"];

    /** Тело плагина: тип таба, словари, тело и заголовок. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), "dsh-remote: dictionaries");
      const t = ctx.locale.bind(NS);

      if (!ctx.sidebarRightTabs || typeof ctx.sidebarRightTabs.register !== "function") {
        // Сборка без API табов сайдбара: панель честно недоступна, плагин живёт.
        ctx.logger?.warn?.("dsh-remote: панель недоступна в этой сборке — нет сервиса sidebarRightTabs");
        return;
      }

      const client = createClient(ctx.connection);
      // Слот передаёт в тело только то, что вернёт эта функция (как boardFace в
      // dsh-kanban): компонент не должен сам лазить в ctx.
      const panelFace = (sessionId) => ({ sessionId, client, t });

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: ID,
            kind: KIND,
            priority: "extension",
            title: () => t("title"),
            guide: [{ order: 40, title: () => t("title"), description: () => t("guide") }]
          }),
        "dsh-remote: tab type"
      );

      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register(
              { name: "sidebar.right.pane.tab", key: ID, locale: NS, inject: panelFace },
              PanelBody
            )
          ),
        "dsh-remote: panel body"
      );
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab.title", () =>
            ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: ID, locale: NS, inject: panelFace }, PanelTitle)
          ),
        "dsh-remote: panel title"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    // Внутренности для тестов и генератора макета: браузеру они не мешают.
    exports.__internals = {
      ID,
      KIND,
      RPC_NAMESPACE,
      statusLines,
      deadlineText,
      clockText,
      createClient
    };

    return module.exports;
  }
});
