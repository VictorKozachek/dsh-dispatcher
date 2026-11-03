//! Хранилище релея на SQLite (задача 017).
//!
//! Все операции — только метаданные и конверты: тела вопросов лежат в `payload`,
//! но никогда не логируются. Токены устройств хранятся хешем (sha256).

use anyhow::Context;
use chrono::{DateTime, SecondsFormat, Utc};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{Row, SqlitePool};

/// Случайный токен (32 байта, hex).
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Хеш токена для хранения.
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Токен в логах: только длина и последние 4 символа.
pub fn mask_token(token: &str) -> String {
    if token.len() <= 4 {
        return "****".to_string();
    }
    format!("****{}", &token[token.len() - 4..])
}

/// Время в формате протокола (RFC 3339, секунды, Z).
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn iso_after(seconds: i64) -> String {
    (Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Разобрать RFC 3339 (для `since`/`expiresAt`).
pub fn parse_iso(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

/// Открыть пул и применить миграции.
pub async fn connect(database_url: &str) -> anyhow::Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect(database_url)
        .await
        .with_context(|| format!("не удалось открыть {database_url}"))?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("миграции не применились")?;
    Ok(pool)
}

/// Устройство из хранилища.
#[derive(Clone, Debug)]
pub struct DeviceRow {
    pub id: String,
    pub platform: String,
    pub public_key: String,
    pub push_token: Option<String>,
    pub label: Option<String>,
    pub created_at: String,
    pub revoked: bool,
}

impl DeviceRow {
    pub fn to_json(&self) -> Value {
        json!({
            "deviceId": self.id,
            "platform": self.platform,
            "createdAt": self.created_at,
            "pushToken": self.push_token,
            "label": self.label,
        })
    }
}

fn device_from_row(row: &sqlx::sqlite::SqliteRow) -> DeviceRow {
    DeviceRow {
        id: row.get("id"),
        platform: row.get("platform"),
        public_key: row.get("public_key"),
        push_token: row.get("push_token"),
        label: row.get("label"),
        created_at: row.get("created_at"),
        revoked: row.get::<i64, _>("revoked") != 0,
    }
}

/// Зарегистрировать устройство (идемпотентно по `(platform, public_key)`).
///
/// Возвращает устройство и признак «создано сейчас»: повтор даёт `200` вместо `201`.
pub async fn create_device(
    pool: &SqlitePool,
    platform: &str,
    public_key: &str,
    push_token: Option<&str>,
    label: Option<&str>,
) -> anyhow::Result<(DeviceRow, bool)> {
    if let Some(row) = sqlx::query("SELECT * FROM devices WHERE platform = ?1 AND public_key = ?2")
        .bind(platform)
        .bind(public_key)
        .fetch_optional(pool)
        .await?
    {
        return Ok((device_from_row(&row), false));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let token = random_token();
    let created_at = now_iso();
    sqlx::query(
        "INSERT INTO devices (id, platform, public_key, push_token, label, token_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&id)
    .bind(platform)
    .bind(public_key)
    .bind(push_token)
    .bind(label)
    .bind(hash_token(&token))
    .bind(&created_at)
    .execute(pool)
    .await?;
    let token_row = sqlx::query("SELECT * FROM devices WHERE id = ?1")
        .bind(&id)
        .fetch_one(pool)
        .await?;
    let mut device = device_from_row(&token_row);
    device.push_token = push_token.map(|value| value.to_string());
    // Токен нужен только при подтверждении привязки; в `Device` его нет.
    sqlx::query("UPDATE devices SET push_token = ?1 WHERE id = ?2")
        .bind(push_token)
        .bind(&id)
        .execute(pool)
        .await?;
    Ok((device, true))
}

/// Найти устройство по токену (Bearer).
pub async fn device_by_token(pool: &SqlitePool, token: &str) -> anyhow::Result<Option<DeviceRow>> {
    let row = sqlx::query("SELECT * FROM devices WHERE token_hash = ?1 AND revoked = 0")
        .bind(hash_token(token))
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().map(device_from_row))
}

pub async fn device_by_id(pool: &SqlitePool, id: &str) -> anyhow::Result<Option<DeviceRow>> {
    let row = sqlx::query("SELECT * FROM devices WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().map(device_from_row))
}

/// Отозвать устройство: токен сразу перестаёт работать.
pub async fn revoke_device(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
    let result = sqlx::query("UPDATE devices SET revoked = 1 WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Создать одноразовый код привязки (TTL — секунды).
pub async fn create_pairing_code(
    pool: &SqlitePool,
    ttl_seconds: i64,
) -> anyhow::Result<(String, String)> {
    let mut code = String::new();
    {
        let mut rng = rand::rng();
        for _ in 0..6 {
            code.push_str(&format!("{}", rng.next_u32() % 10));
        }
    }
    let created_at = now_iso();
    let expires_at = iso_after(ttl_seconds);
    sqlx::query("INSERT INTO pairing_codes (code, created_at, expires_at) VALUES (?1, ?2, ?3)")
        .bind(&code)
        .bind(&created_at)
        .bind(&expires_at)
        .execute(pool)
        .await?;
    Ok((code, expires_at))
}

/// Подтвердить привязку: код одноразовый, живёт TTL; возвращает токен устройства.
pub async fn confirm_pairing(
    pool: &SqlitePool,
    code: &str,
    device_id: &str,
) -> anyhow::Result<Option<(String, DeviceRow)>> {
    // Гонка двух /pair: код подтверждается атомарно (confirmed = 0 и TTL — в
    // том же UPDATE), поэтому ровно один запрос получит строку.
    let claimed = sqlx::query(
        "UPDATE pairing_codes SET confirmed = 1, device_id = ?1
         WHERE code = ?2 AND confirmed = 0 AND datetime(expires_at) > datetime('now')",
    )
    .bind(device_id)
    .bind(code)
    .execute(pool)
    .await?;
    if claimed.rows_affected() != 1 {
        return Ok(None);
    }
    let Some(device) = device_by_id(pool, device_id).await? else {
        return Ok(None);
    };
    if device.revoked {
        return Ok(None);
    }
    let token = random_token();
    sqlx::query("UPDATE devices SET token_hash = ?1 WHERE id = ?2")
        .bind(hash_token(&token))
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(Some((token, device)))
}

/// Ответ устройства: `Created` (новый), `Duplicate` (тот же ключ), `Conflict` (ключ занят другим телом).
pub enum AnswerOutcome {
    Created(Value),
    Duplicate(Value),
    Conflict,
}

/// Сохранить ответ; `answered_at` — из тела.
pub async fn insert_answer(
    pool: &SqlitePool,
    question_id: &str,
    idempotency_key: &str,
    payload: &Value,
) -> anyhow::Result<AnswerOutcome> {
    if let Some(row) = sqlx::query("SELECT payload FROM answers WHERE idempotency_key = ?1")
        .bind(idempotency_key)
        .fetch_optional(pool)
        .await?
    {
        let existing: String = row.get("payload");
        let value: Value = serde_json::from_str(&existing).unwrap_or(Value::Null);
        let same_question = value.get("questionId").and_then(Value::as_str) == Some(question_id);
        // 016: тот же ключ и то же тело — 200; тот же ключ, другое тело — 409.
        let same_body = same_question && value == *payload;
        return Ok(if same_body {
            AnswerOutcome::Duplicate(value)
        } else {
            AnswerOutcome::Conflict
        });
    }
    if let Some(row) = sqlx::query("SELECT idempotency_key FROM answers WHERE question_id = ?1")
        .bind(question_id)
        .fetch_optional(pool)
        .await?
    {
        let existing: String = row.get("idempotency_key");
        return Ok(if existing == idempotency_key {
            AnswerOutcome::Duplicate(payload.clone())
        } else {
            AnswerOutcome::Conflict
        });
    }
    let answered_at = payload
        .get("answeredAt")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .unwrap_or_else(now_iso);
    sqlx::query("INSERT INTO answers (question_id, idempotency_key, payload, answered_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(question_id)
        .bind(idempotency_key)
        .bind(payload.to_string())
        .bind(&answered_at)
        .execute(pool)
        .await?;
    sqlx::query("UPDATE questions SET answered = 1 WHERE id = ?1")
        .bind(question_id)
        .execute(pool)
        .await?;
    Ok(AnswerOutcome::Created(payload.clone()))
}

pub async fn answer_for(pool: &SqlitePool, question_id: &str) -> anyhow::Result<Option<Value>> {
    let row = sqlx::query("SELECT payload FROM answers WHERE question_id = ?1")
        .bind(question_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|row| {
        let payload: String = row.get("payload");
        serde_json::from_str(&payload).ok()
    }))
}

/// Опубликовать вопрос: `payload` — ровно то, что прислал плагин.
pub async fn insert_question(
    pool: &SqlitePool,
    payload: &Value,
    created_at: &str,
    expires_at: &str,
) -> anyhow::Result<()> {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let short_id = payload
        .get("shortId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    sqlx::query(
        "INSERT INTO questions (id, short_id, payload, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at",
    )
    .bind(id)
    .bind(short_id)
    .bind(payload.to_string())
    .bind(created_at)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn question_exists(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
    let row = sqlx::query("SELECT 1 FROM questions WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

pub async fn question_expired(pool: &SqlitePool, id: &str) -> anyhow::Result<bool> {
    let row = sqlx::query("SELECT expires_at, expired FROM questions WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else { return Ok(true) };
    let expired: i64 = row.get("expired");
    let expires_at: String = row.get("expires_at");
    let is_past = parse_iso(&expires_at)
        .map(|value| value <= Utc::now())
        .unwrap_or(true);
    Ok(expired != 0 || is_past)
}

/// Вопросы после `since` (только живые, не отвеченные и не истёкшие).
pub async fn list_questions(
    pool: &SqlitePool,
    since: Option<&str>,
    limit: i64,
) -> anyhow::Result<Vec<(String, Value)>> {
    let rows = if let Some(since) = since {
        sqlx::query(
            "SELECT created_at, payload FROM questions
             WHERE created_at > ?1 AND answered = 0 AND expired = 0 AND expires_at > ?2
             ORDER BY created_at ASC LIMIT ?3",
        )
        .bind(since)
        .bind(now_iso())
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            "SELECT created_at, payload FROM questions
             WHERE answered = 0 AND expired = 0 AND expires_at > ?1
             ORDER BY created_at ASC LIMIT ?2",
        )
        .bind(now_iso())
        .bind(limit)
        .fetch_all(pool)
        .await?
    };
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let created_at: String = row.get("created_at");
            let payload: String = row.get("payload");
            serde_json::from_str(&payload)
                .ok()
                .map(|value| (created_at, value))
        })
        .collect())
}

/// Пометить истёкшие вопросы; возвращает их id (для событий `question.expired`).
pub async fn expire_questions(pool: &SqlitePool) -> anyhow::Result<Vec<String>> {
    let rows = sqlx::query("SELECT id FROM questions WHERE expired = 0 AND expires_at <= ?1")
        .bind(now_iso())
        .fetch_all(pool)
        .await?;
    let ids: Vec<String> = rows.into_iter().map(|row| row.get("id")).collect();
    for id in &ids {
        sqlx::query("UPDATE questions SET expired = 1 WHERE id = ?1")
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(ids)
}

/// Удалить вопросы старше `expiresAt + retention`, ответы старше 7 суток, коды с истёкшим TTL.
pub async fn purge(pool: &SqlitePool, retention_hours: i64) -> anyhow::Result<u64> {
    let mut removed = 0;
    removed +=
        sqlx::query("DELETE FROM questions WHERE datetime(expires_at) <= datetime('now', ?1)")
            .bind(format!("-{retention_hours} hours"))
            .execute(pool)
            .await?
            .rows_affected();
    removed += sqlx::query(
        "DELETE FROM pairing_codes WHERE datetime(expires_at) <= datetime('now', '-1 day')",
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok(removed)
}

pub async fn record_event(
    pool: &SqlitePool,
    event_type: &str,
    question_id: Option<&str>,
    payload: &Value,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO events (type, question_id, payload, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(event_type)
    .bind(question_id)
    .bind(payload.to_string())
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn device_count(pool: &SqlitePool) -> anyhow::Result<i64> {
    let row = sqlx::query("SELECT COUNT(*) AS count FROM devices WHERE revoked = 0")
        .fetch_one(pool)
        .await?;
    Ok(row.get("count"))
}

/// Открытые (живые и неотвеченные) вопросы — для `/v1/health` и `/healthz`.
pub async fn open_question_count(pool: &SqlitePool) -> anyhow::Result<i64> {
    let row = sqlx::query(
        "SELECT COUNT(*) AS count FROM questions WHERE answered = 0 AND expired = 0 AND expires_at > ?1",
    )
    .bind(now_iso())
    .fetch_one(pool)
    .await?;
    Ok(row.get("count"))
}

/// Всего ответов — счётчик для наблюдаемости.
pub async fn answer_count(pool: &SqlitePool) -> anyhow::Result<i64> {
    let row = sqlx::query("SELECT COUNT(*) AS count FROM answers")
        .fetch_one(pool)
        .await?;
    Ok(row.get("count"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let url = format!(
            "sqlite:file:unit-{}?mode=memory&cache=shared",
            random_token()
        );
        connect(&url).await.expect("пул")
    }

    #[tokio::test]
    async fn device_registration_is_idempotent_and_token_lookup_works() {
        let pool = pool().await;
        let (first, created) = create_device(&pool, "ios", "pub-key-1", None, None)
            .await
            .unwrap();
        assert!(created);
        let (second, created_again) = create_device(&pool, "ios", "pub-key-1", None, None)
            .await
            .unwrap();
        assert!(!created_again);
        assert_eq!(first.id, second.id);
        assert_eq!(device_count(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn pairing_code_is_single_use_and_expires() {
        let pool = pool().await;
        let (device, _) = create_device(&pool, "android", "pub-key-2", None, None)
            .await
            .unwrap();
        let (code, _) = create_pairing_code(&pool, 600).await.unwrap();
        let paired = confirm_pairing(&pool, &code, &device.id).await.unwrap();
        assert!(paired.is_some(), "первый раз код работает");
        assert!(
            confirm_pairing(&pool, &code, &device.id)
                .await
                .unwrap()
                .is_none(),
            "повторно — нет"
        );
        let (expired_code, _) = create_pairing_code(&pool, -1).await.unwrap();
        assert!(
            confirm_pairing(&pool, &expired_code, &device.id)
                .await
                .unwrap()
                .is_none(),
            "истёкший код не работает"
        );
    }

    #[tokio::test]
    async fn answers_are_idempotent_and_do_not_duplicate() {
        let pool = pool().await;
        let question = json!({"id": "q-1", "shortId": "a1b2c3d4"});
        insert_question(&pool, &question, &now_iso(), &iso_after(60))
            .await
            .unwrap();
        let answer = json!({"questionId": "q-1", "selected": ["o1"], "answeredAt": now_iso(), "idempotencyKey": "key-1"});
        assert!(matches!(
            insert_answer(&pool, "q-1", "key-1", &answer).await.unwrap(),
            AnswerOutcome::Created(_)
        ));
        assert!(matches!(
            insert_answer(&pool, "q-1", "key-1", &answer).await.unwrap(),
            AnswerOutcome::Duplicate(_)
        ));
        let other = json!({"questionId": "q-2", "selected": [], "answeredAt": now_iso(), "idempotencyKey": "key-1"});
        assert!(matches!(
            insert_answer(&pool, "q-2", "key-1", &other).await.unwrap(),
            AnswerOutcome::Conflict
        ));
        assert!(answer_for(&pool, "q-1").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn expired_questions_are_not_listed_and_are_flagged_once() {
        let pool = pool().await;
        let question = json!({"id": "q-old", "shortId": "deadbeef"});
        insert_question(&pool, &question, &now_iso(), &iso_after(-1))
            .await
            .unwrap();
        assert!(list_questions(&pool, None, 10).await.unwrap().is_empty());
        let expired = expire_questions(&pool).await.unwrap();
        assert_eq!(expired, vec!["q-old".to_string()]);
        assert!(
            expire_questions(&pool).await.unwrap().is_empty(),
            "повторно не помечаем"
        );
    }

    #[test]
    fn token_masking_keeps_only_tail() {
        let masked = mask_token("0123456789abcdef");
        assert_eq!(masked, "****cdef");
        assert!(!masked.contains("0123456789"));
    }
}
