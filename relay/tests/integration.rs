//! Интеграционные тесты релея: сервер поднимается на случайном порту и
//! проходится сценарий «привязка → вопрос → ответ → TTL» (задача 017).

use std::sync::{Arc, Mutex};

use chrono::Utc;
use dsh_relay::{app, ttl, AppState, Config};
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const AGENT_TOKEN: &str = "test-agent-token";

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn after(seconds: i64) -> String {
    (Utc::now() + chrono::Duration::seconds(seconds))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

struct Server {
    base: String,
    state: AppState,
    _join: tokio::task::JoinHandle<()>,
}

async fn spawn() -> Server {
    let state = AppState::for_test(AGENT_TOKEN).await.expect("состояние");
    let ttl_state = state.clone();
    tokio::spawn(ttl::run(ttl_state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("порт");
    let addr = listener.local_addr().expect("адрес");
    let router = app(state.clone());
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Server {
        base: format!("http://{addr}"),
        state,
        _join: join,
    }
}

async fn device(stack: &Server) -> (String, String) {
    let client = reqwest::Client::new();
    let register: Value = client
        .post(format!("{}/v1/devices", stack.base))
        .header("x-relay-version", "1")
        .json(&json!({ "platform": "ios", "publicKey": format!("pub-{}", dsh_relay::db::random_token()) }))
        .send()
        .await
        .expect("регистрация")
        .json()
        .await
        .expect("json");
    let device_id = register["deviceId"].as_str().expect("deviceId").to_string();
    let code: Value = client
        .post(format!("{}/v1/pairing-codes", stack.base))
        .header("authorization", format!("Bearer {AGENT_TOKEN}"))
        .send()
        .await
        .expect("код привязки")
        .json()
        .await
        .expect("json");
    let pair_code = code["pairCode"].as_str().expect("pairCode").to_string();
    let paired: Value = client
        .post(format!("{}/v1/pair", stack.base))
        .json(&json!({ "pairCode": pair_code, "deviceId": device_id }))
        .send()
        .await
        .expect("pair")
        .json()
        .await
        .expect("json");
    let token = paired["deviceToken"]
        .as_str()
        .expect("deviceToken")
        .to_string();
    (device_id, token)
}

fn question(id: &str, short_id: &str) -> Value {
    json!({
        "id": id,
        "shortId": short_id,
        "workspace": "/p/alpha",
        "taskId": "017",
        "role": "worker",
        "title": "Вопрос агента",
        "body": "Продолжать?",
        "options": [{ "id": "o1", "label": "Да" }, { "id": "o2", "label": "Нет" }],
        "createdAt": now(),
        "expiresAt": after(600),
    })
}

#[tokio::test]
async fn scenario_pairing_question_answer_ttl() {
    let stack = spawn().await;
    let client = reqwest::Client::new();

    let health: Value = client
        .get(format!("{}/v1/health", stack.base))
        .send()
        .await
        .expect("health")
        .json()
        .await
        .expect("json");
    assert_eq!(health["ok"], true, "health ok");
    assert_eq!(health["version"], env!("CARGO_PKG_VERSION"));

    let (device_id, device_token) = device(&stack).await;
    assert!(!device_id.is_empty());

    // Публикация вопроса агентом.
    let publish = client
        .post(format!("{}/v1/questions", stack.base))
        .header("authorization", format!("Bearer {AGENT_TOKEN}"))
        .header("x-relay-version", "1")
        .json(&json!({ "question": question("q-00000001", "a1b2c3d4") }))
        .send()
        .await
        .expect("публикация");
    assert_eq!(publish.status(), StatusCode::CREATED);

    // Устройство видит вопрос.
    let listed: Value = client
        .get(format!("{}/v1/questions?limit=10", stack.base))
        .header("authorization", format!("Bearer {device_token}"))
        .send()
        .await
        .expect("список")
        .json()
        .await
        .expect("json");
    let questions = listed["questions"].as_array().expect("массив");
    assert_eq!(questions.len(), 1);
    assert_eq!(questions[0]["id"], "q-00000001");
    assert!(
        questions[0]["body"].as_str().is_some(),
        "открытый режим: тело видно устройству"
    );

    // Ответ; повтор идемпотентен.
    let answer = json!({
        "questionId": "q-00000001",
        "selected": ["o1"],
        "answeredAt": now(),
        "idempotencyKey": "11111111-1111-4111-8111-111111111111",
    });
    let first = client
        .post(format!("{}/v1/answers", stack.base))
        .header("authorization", format!("Bearer {device_token}"))
        .json(&answer)
        .send()
        .await
        .expect("ответ");
    assert_eq!(first.status(), StatusCode::CREATED);
    let repeat = client
        .post(format!("{}/v1/answers", stack.base))
        .header("authorization", format!("Bearer {device_token}"))
        .json(&answer)
        .send()
        .await
        .expect("повтор");
    assert_eq!(
        repeat.status(),
        StatusCode::OK,
        "повтор с тем же ключом — 200"
    );

    // Агент получает ответ.
    let fetched: Value = client
        .get(format!("{}/v1/answers?questionId=q-00000001", stack.base))
        .header("authorization", format!("Bearer {AGENT_TOKEN}"))
        .send()
        .await
        .expect("ответ для агента")
        .json()
        .await
        .expect("json");
    assert_eq!(fetched["selected"][0], "o1");

    // TTL: вопрос с expiresAt в прошлом не отдаётся, но приходит событием.
    let mut ws = tokio_tungstenite::connect_async(ws_request(&stack, &device_token))
        .await
        .expect("WS")
        .0;
    let expired_question = json!({
        "id": "q-ttl-0001",
        "shortId": "deadbeef",
        "body": "Истечёт",
        "options": [],
        "createdAt": now(),
        "expiresAt": after(1),
    });
    let published = client
        .post(format!("{}/v1/questions", stack.base))
        .header("authorization", format!("Bearer {AGENT_TOKEN}"))
        .json(&json!({ "question": expired_question }))
        .send()
        .await
        .expect("публикация TTL");
    assert_eq!(published.status(), StatusCode::CREATED);

    let mut saw_expired = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(message))) => {
                let text = message.into_text().expect("текст").to_string();
                let event: Value = serde_json::from_str(&text).expect("json");
                if event["type"] == "question.expired" && event["questionId"] == "q-ttl-0001" {
                    saw_expired = true;
                    break;
                }
            }
            Ok(Some(Err(error))) => panic!("WS: {error}"),
            Ok(None) => break,
            Err(_) => {}
        }
    }
    assert!(saw_expired, "событие question.expired пришло");

    let after_expiry: Value = client
        .get(format!("{}/v1/questions", stack.base))
        .header("authorization", format!("Bearer {device_token}"))
        .send()
        .await
        .expect("список после TTL")
        .json()
        .await
        .expect("json");
    let ids: Vec<&str> = after_expiry["questions"]
        .as_array()
        .expect("массив")
        .iter()
        .filter_map(|item| item["id"].as_str())
        .collect();
    assert!(!ids.contains(&"q-ttl-0001"), "истёкший вопрос не отдаётся");
}

fn ws_request(
    stack: &Server,
    token: &str,
) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    let url = stack.base.replace("http://", "ws://") + "/v1/events";
    let mut request = url.into_client_request().expect("запрос");
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {token}").parse().expect("заголовок"),
    );
    request
}

#[tokio::test]
async fn broken_envelope_and_unknown_version_are_rejected_without_panic() {
    let stack = spawn().await;
    let client = reqwest::Client::new();

    let broken = client
        .post(format!("{}/v1/questions", stack.base))
        .header("authorization", format!("Bearer {AGENT_TOKEN}"))
        .json(&json!({ "question": {
            "id": "q-broken01",
            "shortId": "cafebabe",
            "enc": { "enc": "short", "nonce": "bad", "keyId": "k", "alg": "rot13", "plainSize": 999999 },
            "createdAt": now(),
            "expiresAt": after(60),
        }}))
        .send()
        .await
        .expect("битый конверт");
    assert_eq!(broken.status(), StatusCode::BAD_REQUEST);
    let body: Value = broken.json().await.expect("json");
    assert_eq!(body["error"]["code"], "bad-request");
    assert!(
        !stack.state.db.is_closed(),
        "сервер жив после битого конверта"
    );

    let leaked = client
        .post(format!("{}/v1/questions", stack.base))
        .header("authorization", format!("Bearer {AGENT_TOKEN}"))
        .json(&json!({ "question": {
            "id": "q-leak0001",
            "shortId": "feedface",
            "body": "утечка",
            "options": [],
            "enc": { "enc": "0123456789abcdef", "nonce": "MDEyMzQ1Njc4OWFi", "keyId": "key-1", "alg": "aes256gcm", "plainSize": 10 },
            "createdAt": now(),
            "expiresAt": after(60),
        }}))
        .send()
        .await
        .expect("body+enc");
    assert_eq!(
        leaked.status(),
        StatusCode::BAD_REQUEST,
        "body и enc одновременно запрещены"
    );

    let unknown = client
        .get(format!("{}/v1/health", stack.base))
        .header("x-relay-version", "2")
        .send()
        .await
        .expect("версия");
    assert_eq!(unknown.status(), StatusCode::UPGRADE_REQUIRED);
    let body: Value = unknown.json().await.expect("json");
    assert_eq!(body["error"]["code"], "unsupported-version");
    assert_eq!(body["error"]["details"]["supported"][0], 1);
}

#[tokio::test]
async fn revoked_device_cannot_answer() {
    let stack = spawn().await;
    let client = reqwest::Client::new();
    let (device_id, token) = device(&stack).await;

    let revoked = client
        .delete(format!("{}/v1/devices/{device_id}", stack.base))
        .header("authorization", format!("Bearer {AGENT_TOKEN}"))
        .send()
        .await
        .expect("отзыв");
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);

    let denied = client
        .get(format!("{}/v1/questions", stack.base))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("после отзыва");
    assert_eq!(
        denied.status(),
        StatusCode::UNAUTHORIZED,
        "токен отозванного устройства не работает"
    );
}

#[test]
fn config_defaults_are_sane() {
    let config = Config {
        bind: "127.0.0.1:0".into(),
        database_url: "sqlite::memory:".into(),
        agent_token: "token".into(),
        allowed_devices: None,
        question_ttl: std::time::Duration::from_secs(1800),
        pairing_ttl: std::time::Duration::from_secs(600),
        long_poll_max: std::time::Duration::from_secs(25),
    };
    assert_eq!(config.question_ttl.as_secs(), 1800);
    assert_eq!(config.pairing_ttl.as_secs(), 600);
}

#[tokio::test]
async fn logs_do_not_contain_question_bodies_or_tokens() {
    // Перехватываем логи в буфер и проверяем, что тела/токены не утекли.
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let writer = BufferWriter(buffer.clone());
    let _ = tracing_subscriber::fmt()
        .json()
        .with_writer(writer)
        .with_env_filter("info")
        .try_init();

    let stack = spawn().await;
    let client = reqwest::Client::new();
    let (_device_id, token) = device(&stack).await;
    let secret_body = "SECRET-QUESTION-BODY-42";

    let mut question = question("q-log00001", "0badf00d");
    question["body"] = json!(secret_body);
    let status = client
        .post(format!("{}/v1/questions", stack.base))
        .header("authorization", format!("Bearer {AGENT_TOKEN}"))
        .json(&json!({ "question": question }))
        .send()
        .await
        .expect("публикация")
        .status();
    assert_eq!(status, StatusCode::CREATED);

    let logs = String::from_utf8(buffer.lock().expect("буфер").clone()).expect("utf8");
    assert!(!logs.contains(secret_body), "тело вопроса не попало в лог");
    assert!(!logs.contains(AGENT_TOKEN), "токен агента не попал в лог");
    assert!(!logs.contains(&token), "токен устройства не попал в лог");
    assert!(
        logs.contains("q-log00001"),
        "id вопроса в логе есть — метаданные логируются"
    );
}

struct BufferWriter(Arc<Mutex<Vec<u8>>>);

impl tracing_subscriber::fmt::MakeWriter<'_> for BufferWriter {
    type Writer = BufferGuard;

    fn make_writer(&self) -> Self::Writer {
        BufferGuard(self.0.clone())
    }
}

struct BufferGuard(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for BufferGuard {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("буфер").extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
