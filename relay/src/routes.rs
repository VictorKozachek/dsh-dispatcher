//! HTTP-эндпоинты релея (протокол v1, задача 017).
//!
//! Логи содержат только метаданные: id вопроса, короткий id, код ошибки. Тела
//! вопросов, ответов, конверты и токены в логи не попадают.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};

use crate::{db, AppState};

/// Ответ об ошибке по протоколу: `{"error": {...}}`.
pub fn error_response(
    status: StatusCode,
    code: &str,
    message: &str,
    retryable: bool,
    details: Option<Value>,
) -> Response {
    let mut error = json!({ "code": code, "message": message, "retryable": retryable });
    if let Some(details) = details {
        error["details"] = details;
    }
    (status, Json(json!({ "error": error }))).into_response()
}

fn bad_request(message: &str) -> Response {
    error_response(StatusCode::BAD_REQUEST, "bad-request", message, false, None)
}

fn unauthorized() -> Response {
    error_response(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "нужен Bearer-токен",
        false,
        None,
    )
}

fn not_found(what: &str) -> Response {
    error_response(StatusCode::NOT_FOUND, "not-found", what, false, None)
}

fn conflict(message: &str) -> Response {
    error_response(StatusCode::CONFLICT, "conflict", message, false, None)
}

fn expired() -> Response {
    error_response(
        StatusCode::GONE,
        "expired",
        "вопрос истёк по TTL",
        false,
        None,
    )
}

fn internal() -> Response {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "внутренний сбой",
        true,
        None,
    )
}

/// Отвергнуть незнакомые поля: 016 требует `additionalProperties: false`
/// на запросах, иначе опечатка в имени поля молча теряется.
fn reject_unknown(body: &Value, allowed: &[&str]) -> Result<(), String> {
    let Some(object) = body.as_object() else {
        return Err("ожидался JSON-объект".into());
    };
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("лишнее поле {key}"));
        }
    }
    Ok(())
}

/// `version` в теле (если есть) обязан быть 1: иначе клиент и сервер
/// разойдутся молча.
fn validate_body_version(body: &Value) -> Result<(), String> {
    match body.get("version") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Number(value)) if value.as_u64() == Some(1) => Ok(()),
        Some(_) => Err("version: поддерживается только 1".into()),
    }
}

/// Кто вызывает: агент (плагин) или устройство.
enum Auth {
    Agent,
    Device(db::DeviceRow),
}

/// Разобрать `Authorization: Bearer ...`; для агента сверяем токен, для устройства — хеш.
async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Auth, Response> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string());
    let Some(token) = token else {
        return Err(unauthorized());
    };
    if token == state.config.agent_token {
        return Ok(Auth::Agent);
    }
    match db::device_by_token(&state.db, &token).await {
        Ok(Some(device)) => Ok(Auth::Device(device)),
        Ok(None) => Err(unauthorized()),
        Err(error) => {
            tracing::error!(error = %error, "поиск устройства по токену не удался");
            Err(internal())
        }
    }
}

fn device_allowed(state: &AppState, device_id: &str) -> bool {
    match &state.config.allowed_devices {
        Some(list) => list.contains(device_id),
        None => true,
    }
}

/// `GET /v1/health` — живость, версия и счётчики (без секретов).
pub async fn health(State(state): State<AppState>) -> Response {
    let devices = db::device_count(&state.db).await.unwrap_or(0);
    let questions = db::open_question_count(&state.db).await.unwrap_or(0);
    let answers = db::answer_count(&state.db).await.unwrap_or(0);
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "at": db::now_iso(),
        "devices": devices,
        "questions": questions,
        "answers": answers,
    }))
    .into_response()
}

/// `POST /v1/devices` — регистрация устройства.
pub async fn create_device(State(state): State<AppState>, body: Option<Json<Value>>) -> Response {
    let Some(Json(body)) = body else {
        return bad_request("нужно JSON-тело");
    };
    if let Err(reason) = reject_unknown(
        &body,
        &["platform", "publicKey", "pushToken", "label", "version"],
    ) {
        return bad_request(&reason);
    }
    if let Err(reason) = validate_body_version(&body) {
        return bad_request(&reason);
    }
    let platform = body.get("platform").and_then(Value::as_str).unwrap_or("");
    if !matches!(platform, "ios" | "android" | "web") {
        return bad_request("platform: ожидалось ios, android или web");
    }
    let public_key = body.get("publicKey").and_then(Value::as_str).unwrap_or("");
    if public_key.len() < 32 || public_key.len() > 4096 {
        return bad_request("publicKey: ожидалась base64-строка 32..4096 символов");
    }
    let push_token = body.get("pushToken").and_then(Value::as_str);
    let label = body.get("label").and_then(Value::as_str);
    match db::create_device(&state.db, platform, public_key, push_token, label).await {
        Ok((device, created)) => {
            tracing::info!(device = %device.id, platform, created, "устройство зарегистрировано");
            let status = if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, Json(device.to_json())).into_response()
        }
        Err(error) => {
            tracing::error!(error = %error, "регистрация устройства не удалась");
            internal()
        }
    }
}

/// `DELETE /v1/devices/{id}` — отзыв устройства; его WebSocket-сессии закрываются.
pub async fn delete_device(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let auth = match authenticate(&state, &headers).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let allowed = match &auth {
        Auth::Agent => true,
        Auth::Device(device) => device.id == id,
    };
    if !allowed {
        return error_response(
            StatusCode::FORBIDDEN,
            "forbidden",
            "чужое устройство",
            false,
            None,
        );
    }
    match db::revoke_device(&state.db, &id).await {
        Ok(true) => {
            tracing::info!(device = %id, "устройство отозвано");
            let _ = state
                .events
                .send(crate::RelayEvent::DeviceRevoked(id.clone()));
            let event = json!({ "type": "device.revoked", "at": db::now_iso(), "payload": { "deviceId": id } });
            state.publish(event);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => not_found("устройство не найдено"),
        Err(error) => {
            tracing::error!(error = %error, "отзыв устройства не удался");
            internal()
        }
    }
}

/// `POST /v1/pairing-codes` — плагин получает код для показа человеку.
pub async fn create_pairing_code(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match authenticate(&state, &headers).await {
        Ok(Auth::Agent) => {}
        Ok(Auth::Device(_)) => {
            return error_response(
                StatusCode::FORBIDDEN,
                "forbidden",
                "нужен токен агента",
                false,
                None,
            )
        }
        Err(response) => return response,
    }
    let ttl = state.config.pairing_ttl.as_secs() as i64;
    match db::create_pairing_code(&state.db, ttl).await {
        Ok((code, expires_at)) => {
            tracing::info!(expires_at = %expires_at, "создан код привязки");
            (
                StatusCode::CREATED,
                Json(json!({ "pairCode": code, "expiresAt": expires_at })),
            )
                .into_response()
        }
        Err(error) => {
            tracing::error!(error = %error, "код привязки не создался");
            internal()
        }
    }
}

/// `POST /v1/pair` — подтверждение привязки: выдаёт `deviceToken`.
pub async fn pair(State(state): State<AppState>, Json(body): Json<Value>) -> Response {
    if let Err(reason) = reject_unknown(&body, &["pairCode", "deviceId", "version"]) {
        return bad_request(&reason);
    }
    if let Err(reason) = validate_body_version(&body) {
        return bad_request(&reason);
    }
    let code = body.get("pairCode").and_then(Value::as_str).unwrap_or("");
    let device_id = body.get("deviceId").and_then(Value::as_str).unwrap_or("");
    if code.len() != 6 || !code.chars().all(|ch| ch.is_ascii_digit()) {
        return bad_request("pairCode: ожидались 6 цифр");
    }
    if device_id.is_empty() {
        return bad_request("deviceId обязателен");
    }
    if !device_allowed(&state, device_id) {
        return error_response(
            StatusCode::FORBIDDEN,
            "forbidden",
            "устройство не в allowlist",
            false,
            None,
        );
    }
    match db::confirm_pairing(&state.db, code, device_id).await {
        Ok(Some((token, device))) => {
            tracing::info!(device = %device.id, "привязка подтверждена");
            let event = json!({
                "type": "pairing.confirmed",
                "at": db::now_iso(),
                "payload": { "deviceId": device.id },
            });
            state.publish(event);
            (
                StatusCode::OK,
                Json(json!({
                    "deviceToken": token,
                    "device": device.to_json(),
                    "confirmedAt": db::now_iso(),
                })),
            )
                .into_response()
        }
        Ok(None) => not_found("код привязки не найден, истёк или уже использован"),
        Err(error) => {
            tracing::error!(error = %error, "привязка не удалась");
            internal()
        }
    }
}

/// Проверка конверта e2e (`enc`): сервер видит только эти поля.
fn validate_enc(enc: &Value) -> Result<(), String> {
    let field = |name: &str| enc.get(name).and_then(Value::as_str).unwrap_or("");
    let (cipher, nonce, key_id, alg) = (field("enc"), field("nonce"), field("keyId"), field("alg"));
    if cipher.len() < 16 || cipher.len() > 65536 {
        return Err("enc: ожидалась base64-строка 16..65536".into());
    }
    if nonce.len() != 16 {
        return Err("nonce: ожидались 16 base64-символов (12 байт)".into());
    }
    if key_id.len() < 4 || key_id.len() > 64 {
        return Err("keyId: ожидалось 4..64 символа".into());
    }
    if !matches!(alg, "xchacha20poly1305" | "aes256gcm") {
        return Err("alg: поддерживаются xchacha20poly1305 и aes256gcm".into());
    }
    if let Err(reason) = reject_unknown(enc, &["enc", "nonce", "keyId", "alg", "plainSize"]) {
        return Err(reason);
    }
    let size = enc.get("plainSize").and_then(Value::as_i64).unwrap_or(-1);
    if !(0..=49152).contains(&size) {
        return Err("plainSize: ожидалось 0..49152".into());
    }
    Ok(())
}

fn has(field: &Value, name: &str) -> bool {
    field.get(name).is_some_and(|value| !value.is_null())
}

/// Проверка вопроса по схеме 016: открытый режим (body+options) **или** e2e (`enc`).
fn validate_question(question: &Value) -> Result<(), String> {
    let string = |name: &str| question.get(name).and_then(Value::as_str);
    if string("id").unwrap_or("").len() < 8 {
        return Err("id: ожидался uuid".into());
    }
    let short_id = string("shortId").unwrap_or("");
    if short_id.len() != 8 || !short_id.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("shortId: ожидались 8 hex-символов".into());
    }
    for field in ["createdAt", "expiresAt"] {
        if db::parse_iso(string(field).unwrap_or("")).is_none() {
            return Err(format!("{field}: ожидался RFC 3339"));
        }
    }
    let enc = question.get("enc").filter(|value| !value.is_null());
    if let Some(enc) = enc {
        // e2e: открытых полей быть не должно — иначе приватность нарушена.
        for forbidden in ["body", "title", "detail", "options"] {
            if has(question, forbidden) {
                return Err(format!(
                    "{forbidden}: в e2e-режиме поле запрещено (используйте enc)"
                ));
            }
        }
        return validate_enc(enc);
    }
    let body = string("body").unwrap_or("");
    if body.is_empty() || body.chars().count() > 4000 {
        return Err("body: ожидалось 1..4000 символов".into());
    }
    if let Some(title) = string("title") {
        if title.chars().count() > 200 {
            return Err("title: максимум 200 символов".into());
        }
    }
    if let Some(detail) = string("detail") {
        if detail.chars().count() > 2000 {
            return Err("detail: максимум 2000 символов".into());
        }
    }
    let Some(options) = question.get("options").and_then(Value::as_array) else {
        return Err("options: обязателен массив вариантов (может быть пустым)".into());
    };
    if options.len() > 10 {
        return Err("options: максимум 10 вариантов".into());
    }
    for option in options {
        if let Err(reason) = reject_unknown(option, &["id", "label"]) {
            return Err(format!("options[]: {reason}"));
        }
        let id = option.get("id").and_then(Value::as_str).unwrap_or("");
        let label = option.get("label").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() || id.len() > 8 {
            return Err("options[].id: ожидалось 1..8 символов".into());
        }
        if label.is_empty() || label.chars().count() > 120 {
            return Err("options[].label: ожидалось 1..120 символов".into());
        }
    }
    Ok(())
}

/// `POST /v1/questions` — публикация вопроса агентом.
pub async fn publish_question(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    match authenticate(&state, &headers).await {
        Ok(Auth::Agent) => {}
        Ok(Auth::Device(_)) => {
            return error_response(
                StatusCode::FORBIDDEN,
                "forbidden",
                "нужен токен агента",
                false,
                None,
            )
        }
        Err(response) => return response,
    }
    if let Err(reason) = reject_unknown(&body, &["question", "version"]) {
        return bad_request(&reason);
    }
    let Some(question) = body
        .get("question")
        .filter(|value| value.is_object())
        .cloned()
    else {
        return bad_request("нужен wrapper {\"question\": {...}} (QuestionPublishRequest)");
    };
    if let Err(reason) = validate_body_version(&body) {
        return bad_request(&reason);
    }
    if let Err(reason) = reject_unknown(
        &question,
        &[
            "id",
            "shortId",
            "workspace",
            "taskId",
            "role",
            "title",
            "body",
            "detail",
            "options",
            "optionCount",
            "multiSelect",
            "allowFreeText",
            "createdAt",
            "expiresAt",
            "enc",
            "version",
        ],
    ) {
        return bad_request(&reason);
    }
    if let Err(reason) = validate_body_version(&question) {
        return bad_request(&reason);
    }
    if let Err(reason) = validate_question(&question) {
        tracing::warn!(reason = %reason, "вопрос отклонён");
        return bad_request(&reason);
    }
    let id = question
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let short_id = question
        .get("shortId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let created_at = question
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let expires_at = question
        .get("expiresAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Err(error) = db::insert_question(&state.db, &question, &created_at, &expires_at).await {
        tracing::error!(error = %error, question = %id, "вопрос не сохранён");
        return internal();
    }
    tracing::info!(question = %id, short_id = %short_id, "вопрос опубликован");
    let event = json!({
        "type": "question.created",
        "at": db::now_iso(),
        "questionId": id,
    });
    let _ = db::record_event(&state.db, "question.created", Some(&id), &event).await;
    state.publish(event);
    (StatusCode::CREATED, Json(question)).into_response()
}

/// `GET /v1/questions?since=&limit=&wait=` — вопросы для устройства (long-poll).
pub async fn list_questions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    match authenticate(&state, &headers).await {
        Ok(Auth::Device(device)) => {
            if device.revoked {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "устройство отозвано",
                    false,
                    None,
                );
            }
            if !device_allowed(&state, &device.id) {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "устройство не в allowlist",
                    false,
                    None,
                );
            }
        }
        Ok(Auth::Agent) => {}
        Err(response) => return response,
    }
    let since = query.get("since").cloned();
    let since_id = query.get("sinceId").cloned();
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| (1..=100).contains(value))
        .unwrap_or(50);
    let wait = query
        .get("wait")
        .and_then(|value| value.parse::<u64>().ok())
        .map(|secs| secs.min(state.config.long_poll_max.as_secs()))
        .unwrap_or(0);
    let mut events = state.events.subscribe();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait);
    loop {
        let cursor = since.as_deref().map(|value| (value, since_id.as_deref()));
        match db::list_questions(&state.db, cursor, limit).await {
            Ok(rows) if !rows.is_empty() || wait == 0 => {
                // Курсор — created_at последнего элемента: страница не теряет
                // остаток и не повторяет уже отданное.
                let last = rows.last().map(|(created_at, value)| {
                    (created_at.clone(), value.get("id").and_then(Value::as_str).unwrap_or("").to_string())
                });
                let next_since = last
                    .as_ref()
                    .map(|(created_at, _)| created_at.clone())
                    .or_else(|| since.clone())
                    .unwrap_or_else(db::now_iso);
                let next_id = last.map(|(_, id)| id).unwrap_or_default();
                let questions: Vec<Value> = rows.into_iter().map(|(_, value)| value).collect();
                return Json(json!({
                    "questions": questions,
                    "nextSince": next_since,
                    "nextId": next_id,
                }))
                .into_response();
            }
            Ok(_) => {}
            Err(error) => {
                tracing::error!(error = %error, "список вопросов не прочитан");
                return internal();
            }
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Json(json!({ "questions": [], "nextSince": db::now_iso() })).into_response();
        }
        match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Ok(crate::RelayEvent::Protocol(event)))
                if event.get("type").and_then(Value::as_str) == Some("question.created") => {}
            Ok(Ok(_)) | Ok(Err(_)) => {}
            Err(_) => {
                return Json(json!({ "questions": [], "nextSince": db::now_iso() })).into_response()
            }
        }
    }
}

fn validate_answer(answer: &Value) -> Result<(), String> {
    if answer
        .get("questionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
    {
        return Err("questionId обязателен".into());
    }
    if db::parse_iso(
        answer
            .get("answeredAt")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .is_none()
    {
        return Err("answeredAt: ожидался RFC 3339".into());
    }
    let key = answer
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    if key.len() < 16
        || key.len() > 64
        || !key.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-')
    {
        return Err("idempotencyKey: ожидался uuid/hex 16..64".into());
    }
    let enc = answer.get("enc").filter(|value| !value.is_null());
    if let Some(enc) = enc {
        for forbidden in ["selected", "custom"] {
            if has(answer, forbidden) {
                return Err(format!(
                    "{forbidden}: в e2e-режиме поле запрещено (используйте enc)"
                ));
            }
        }
        return validate_enc(enc);
    }
    let Some(selected) = answer.get("selected").and_then(Value::as_array) else {
        return Err("selected: обязателен массив id вариантов (может быть пустым)".into());
    };
    if selected.len() > 10 {
        return Err("selected: максимум 10 значений".into());
    }
    for item in selected {
        let value = item.as_str().unwrap_or("");
        if value.is_empty() || value.len() > 8 {
            return Err("selected[]: ожидались id вариантов 1..8 символов".into());
        }
    }
    if let Some(custom) = answer.get("custom").and_then(Value::as_str) {
        if custom.chars().count() > 2000 {
            return Err("custom: максимум 2000 символов".into());
        }
    }
    Ok(())
}

/// `POST /v1/answers` — ответ человека; идемпотентно по `idempotencyKey`.
pub async fn answer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    match authenticate(&state, &headers).await {
        Ok(Auth::Device(device)) => {
            if device.revoked {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "устройство отозвано",
                    false,
                    None,
                );
            }
            if !device_allowed(&state, &device.id) {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "устройство не в allowlist",
                    false,
                    None,
                );
            }
        }
        Ok(Auth::Agent) => {}
        Err(response) => return response,
    }
    if let Err(reason) = reject_unknown(
        &body,
        &[
            "questionId",
            "selected",
            "custom",
            "answeredAt",
            "idempotencyKey",
            "enc",
            "version",
        ],
    ) {
        return bad_request(&reason);
    }
    if let Err(reason) = validate_body_version(&body) {
        return bad_request(&reason);
    }
    if let Err(reason) = validate_answer(&body) {
        return bad_request(&reason);
    }
    let question_id = body
        .get("questionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let idempotency_key = body
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    match db::question_exists(&state.db, &question_id).await {
        Ok(false) => return not_found("вопрос не найден"),
        Ok(true) => {}
        Err(error) => {
            tracing::error!(error = %error, "проверка вопроса не удалась");
            return internal();
        }
    }
    match db::question_expired(&state.db, &question_id).await {
        Ok(true) => return expired(),
        Ok(false) => {}
        Err(error) => {
            tracing::error!(error = %error, "проверка TTL не удалась");
            return internal();
        }
    }
    match db::insert_answer(&state.db, &question_id, &idempotency_key, &body).await {
        Ok(db::AnswerOutcome::Created(answer)) => {
            tracing::info!(question = %question_id, "ответ получен");
            let event = json!({
                "type": "question.answered",
                "at": db::now_iso(),
                "questionId": question_id,
                "payload": { "answeredAt": answer.get("answeredAt") },
            });
            let _ =
                db::record_event(&state.db, "question.answered", Some(&question_id), &event).await;
            state.publish(event);
            (StatusCode::CREATED, Json(answer)).into_response()
        }
        Ok(db::AnswerOutcome::Duplicate(answer)) => (StatusCode::OK, Json(answer)).into_response(),
        Ok(db::AnswerOutcome::Conflict) => conflict("idempotencyKey уже занят другим ответом"),
        Err(error) => {
            tracing::error!(error = %error, question = %question_id, "ответ не сохранён");
            internal()
        }
    }
}

/// `GET /v1/answers?questionId=&wait=` — ответ для плагина (long-poll).
pub async fn get_answer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    match authenticate(&state, &headers).await {
        Ok(Auth::Agent) => {}
        Ok(Auth::Device(_)) => {
            return error_response(
                StatusCode::FORBIDDEN,
                "forbidden",
                "нужен токен агента",
                false,
                None,
            )
        }
        Err(response) => return response,
    }
    let Some(question_id) = query.get("questionId").cloned() else {
        return bad_request("questionId обязателен");
    };
    let wait = query
        .get("wait")
        .and_then(|value| value.parse::<u64>().ok())
        .map(|secs| secs.min(state.config.long_poll_max.as_secs()))
        .unwrap_or(0);
    let mut events = state.events.subscribe();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait);
    loop {
        match db::answer_for(&state.db, &question_id).await {
            Ok(Some(answer)) => return Json(answer).into_response(),
            Ok(None) => {}
            Err(error) => {
                tracing::error!(error = %error, question = %question_id, "ответ не прочитан");
                return internal();
            }
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return not_found("ответа пока нет");
        }
        match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Ok(crate::RelayEvent::Protocol(event)))
                if event.get("type").and_then(Value::as_str) == Some("question.answered") => {}
            Ok(Ok(_)) | Ok(Err(_)) => {}
            Err(_) => return not_found("ответа пока нет"),
        }
    }
}

/// `POST /v1/heartbeat` — устройство живо.
pub async fn heartbeat(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match authenticate(&state, &headers).await {
        Ok(Auth::Device(device)) => {
            if device.revoked {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "forbidden",
                    "устройство отозвано",
                    false,
                    None,
                );
            }
            match sqlx::query("UPDATE devices SET last_seen = ?1 WHERE id = ?2")
                .bind(db::now_iso())
                .bind(&device.id)
                .execute(&state.db)
                .await
            {
                Ok(_) => StatusCode::NO_CONTENT.into_response(),
                Err(error) => {
                    tracing::error!(error = %error, "heartbeat не сохранён");
                    internal()
                }
            }
        }
        Ok(Auth::Agent) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

/// Текущее время для событий (используется и в ws).
pub fn event_time() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
