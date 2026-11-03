//! Общие типы и настройка приложения релея (протокол v1, задача 017).
//!
//! Сервер не хранит ключей e2e: он видит только конверт (`enc`, `nonce`,
//! `keyId`, `alg`, `plainSize`) и метаданные вопроса. Тела вопросов и токены
//! никогда не попадают в логи.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use tokio::sync::broadcast;
use tracing::info;

pub mod db;
pub mod routes;
pub mod ttl;
pub mod ws;

/// Версия протокола, которую понимает сервер.
pub const PROTOCOL_VERSION: u32 = 1;

/// Событие потока (`GET /v1/events` и long-poll).
#[derive(Clone, Debug)]
pub enum RelayEvent {
    /// Событие протокола (`question.created`, `question.answered`, ...).
    Protocol(Value),
    /// Устройство отозвано: его WebSocket-сессии закрываются.
    DeviceRevoked(String),
}

/// Конфигурация из окружения (значения по умолчанию — для локального запуска).
#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub database_url: String,
    pub agent_token: String,
    /// Если задан — регистрироваться и отвечать могут только эти устройства.
    pub allowed_devices: Option<HashSet<String>>,
    pub question_ttl: Duration,
    pub pairing_ttl: Duration,
    pub long_poll_max: Duration,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let agent_token = std::env::var("RELAY_AGENT_TOKEN").unwrap_or_else(|_| {
            let token = db::random_token();
            info!(
                token_hint = %db::mask_token(&token),
                "RELAY_AGENT_TOKEN не задан — сгенерирован на этот запуск"
            );
            token
        });
        let allowed_devices = std::env::var("RELAY_ALLOWED_DEVICES").ok().map(|raw| {
            raw.split(',')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        });
        Ok(Self {
            bind: std::env::var("RELAY_BIND").unwrap_or_else(|_| "127.0.0.1:8080".to_string()),
            database_url: std::env::var("RELAY_DATABASE_URL")
                .unwrap_or_else(|_| "sqlite://relay.db?mode=rwc".to_string()),
            agent_token,
            allowed_devices,
            question_ttl: Duration::from_secs(env_secs("RELAY_QUESTION_TTL_SECONDS", 1800)),
            pairing_ttl: Duration::from_secs(env_secs("RELAY_PAIRING_TTL_SECONDS", 600)),
            long_poll_max: Duration::from_secs(env_secs("RELAY_LONG_POLL_MAX_SECONDS", 25)),
        })
    }
}

fn env_secs(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// Состояние приложения (общее для всех запросов).
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: SqlitePool,
    pub events: broadcast::Sender<RelayEvent>,
}

impl AppState {
    /// Открыть хранилище и применить миграции.
    pub async fn new(config: Config) -> anyhow::Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect(&config.database_url)
            .await
            .with_context(|| format!("не удалось открыть {}", config.database_url))?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .context("миграции не применились")?;
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            config: Arc::new(config),
            db: pool,
            events,
        })
    }

    /// Состояние для тестов: SQLite в памяти, токен агента из переменной.
    pub async fn for_test(agent_token: &str) -> anyhow::Result<Self> {
        let mut config = Config {
            bind: "127.0.0.1:0".to_string(),
            database_url: "sqlite::memory:".to_string(),
            agent_token: agent_token.to_string(),
            allowed_devices: None,
            question_ttl: Duration::from_secs(1800),
            pairing_ttl: Duration::from_secs(600),
            long_poll_max: Duration::from_secs(5),
        };
        config.database_url = format!(
            "sqlite:file:relay-test-{}?mode=memory&cache=shared",
            db::random_token()
        );
        Self::new(config).await
    }

    /// Опубликовать событие протокола в поток.
    pub fn publish(&self, event: Value) {
        let _ = self.events.send(RelayEvent::Protocol(event));
    }
}

/// Роутер приложения.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(routes::health))
        .route("/healthz", get(routes::health))
        .route("/v1/devices", post(routes::create_device))
        .route("/v1/devices/{id}", delete(routes::delete_device))
        .route("/v1/pair", post(routes::pair))
        .route("/v1/pairing-codes", post(routes::create_pairing_code))
        .route(
            "/v1/questions",
            post(routes::publish_question).get(routes::list_questions),
        )
        .route("/v1/answers", post(routes::answer).get(routes::get_answer))
        .route("/v1/heartbeat", post(routes::heartbeat))
        .route("/v1/events", get(ws::events))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            version_guard,
        ))
        .with_state(state)
}

/// Проверка `X-Relay-Version`: несовпадение — 426 с поддерживаемыми версиями.
async fn version_guard(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let requested = request
        .headers()
        .get("x-relay-version")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string());
    match requested {
        None => {
            // 016 §2: заголовок несёт каждый запрос; без него непонятно, какой
            // версии клиент — отвечаем 400, а не угадываем.
            let mut response = routes::error_response(
                StatusCode::BAD_REQUEST,
                "bad-request",
                "нужен заголовок X-Relay-Version: 1",
                false,
                Some(json!({ "supported": [PROTOCOL_VERSION] })),
            );
            response
                .headers_mut()
                .insert("x-relay-version", HeaderValue::from_static("1"));
            return response;
        }
        Some(version) if version != PROTOCOL_VERSION.to_string() => {
            let mut response = routes::error_response(
                StatusCode::UPGRADE_REQUIRED,
                "unsupported-version",
                "релей не поддерживает эту версию протокола",
                true,
                Some(json!({ "supported": [PROTOCOL_VERSION] })),
            );
            response
                .headers_mut()
                .insert("x-relay-version", HeaderValue::from_static("1"));
            return response;
        }
        Some(_) => {}
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("x-relay-version", HeaderValue::from_static("1"));
    let _ = response.headers_mut();
    let _ = &state;
    response
}

/// Тело ошибки по протоколу: `{"error": {...}}`.
#[allow(dead_code)]
fn _assert_error_shape() -> Response {
    routes::error_response(StatusCode::BAD_REQUEST, "bad-request", "x", false, None).into_response()
}
