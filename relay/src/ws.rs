//! WebSocket-поток событий (`GET /v1/events`, задача 017).
//!
//! Каждые 25 секунд сервер шлёт ping; если pong не пришёл за 10 секунд —
//! соединение закрывается кодом 1001. При отзыве устройства его сессии
//! закрываются принудительно.

use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use futures_util::StreamExt;
use serde_json::json;
use tokio::time::{interval, timeout, Instant};

use crate::{db, routes, AppState, RelayEvent};

const PING_EVERY: Duration = Duration::from_secs(25);
const PONG_TIMEOUT: Duration = Duration::from_secs(10);

/// `GET /v1/events` — upgrade в WebSocket.
pub async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let device_id = match authenticate(&state, &headers).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    upgrade.on_upgrade(move |socket| handle(state, socket, device_id))
}

/// Кто подключился: устройство (по токену) или агент.
async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Option<String>, Response> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string());
    let Some(token) = token else {
        return Err(routes::error_response(
            axum::http::StatusCode::UNAUTHORIZED,
            "unauthorized",
            "нужен Bearer-токен",
            false,
            None,
        ));
    };
    if token == state.config.agent_token {
        return Ok(None);
    }
    match db::device_by_token(&state.db, &token).await {
        Ok(Some(device)) => {
            // Same allowlist as HTTP-эндпоинты: устройство вне списка не должно
            // получать поток событий.
            let allowed = match &state.config.allowed_devices {
                Some(list) => list.contains(&device.id),
                None => true,
            };
            if !allowed {
                return Err(routes::error_response(
                    axum::http::StatusCode::FORBIDDEN,
                    "forbidden",
                    "устройство не в allowlist",
                    false,
                    None,
                ));
            }
            Ok(Some(device.id))
        }
        Ok(None) => Err(routes::error_response(
            axum::http::StatusCode::UNAUTHORIZED,
            "unauthorized",
            "неизвестный токен",
            false,
            None,
        )),
        Err(error) => {
            tracing::error!(error = %error, "WS: токен не проверен");
            Err(routes::error_response(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "внутренний сбой",
                true,
                None,
            ))
        }
    }
}

async fn handle(state: AppState, mut socket: WebSocket, device_id: Option<String>) {
    let mut events = state.events.subscribe();
    let mut ping = interval(PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tracing::info!(device = ?device_id, "WS-клиент подключён");
    loop {
        tokio::select! {
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Text(_))) => { /* клиентские команды не предусмотрены */ }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        tracing::debug!(error = %error, "WS: ошибка кадра");
                        break;
                    }
                }
            }
            event = events.recv() => {
                match event {
                    Ok(RelayEvent::DeviceRevoked(id)) if Some(&id) == device_id.as_ref() => {
                        close_with(&mut socket, 1001, "устройство отозвано").await;
                        break;
                    }
                    Ok(RelayEvent::DeviceRevoked(id)) => {
                        tracing::debug!(device = %id, "WS: чужой отзыв — игнор");
                    }
                    Ok(RelayEvent::Protocol(event)) => {
                        // Событие с `payload.deviceId` адресовано конкретному
                        // устройству (pairing.confirmed, device.revoked) — чужим
                        // его не отдаём. Вопросы/ответы — общие для устройств
                        // пользователя (релей однопользовательский).
                        let target = event
                            .get("payload")
                            .and_then(|payload| payload.get("deviceId"))
                            .and_then(serde_json::Value::as_str);
                        if let (Some(target), Some(mine)) = (target, device_id.as_deref()) {
                            if target != mine {
                                continue;
                            }
                        }
                        if let Ok(text) = serde_json::to_string(&event) {
                            if socket.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "WS: поток отстал, часть событий пропущена");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = ping.tick() => {
                let payload = json!({ "type": "heartbeat", "at": db::now_iso() });
                if socket.send(Message::Ping(axum::body::Bytes::from(payload.to_string()))).await.is_err() {
                    break;
                }
                let pong = timeout(PONG_TIMEOUT, wait_pong(&mut socket)).await;
                if !matches!(pong, Ok(true)) {
                    tracing::info!(device = ?device_id, "WS: pong не получен — закрываю");
                    close_with(&mut socket, 1001, "pong не получен").await;
                    break;
                }
            }
        }
    }
    tracing::info!(device = ?device_id, "WS-клиент отключён");
}

/// Ждать pong до следующего ping (остальные кадры игнорируются).
async fn wait_pong(socket: &mut WebSocket) -> bool {
    let deadline = Instant::now() + PONG_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match timeout(remaining, socket.next()).await {
            Ok(Some(Ok(Message::Pong(_)))) => return true,
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(_))) | Ok(None) => return false,
            Err(_) => return false,
        }
    }
}

async fn close_with(socket: &mut WebSocket, code: u16, reason: &str) {
    let frame = CloseFrame {
        code,
        reason: reason.to_string().into(),
    };
    let _ = socket.send(Message::Close(Some(frame))).await;
}
