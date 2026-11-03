//! Фоновые задачи: TTL вопросов, событие `question.expired`, очистка старых данных (017).
//!
//! Задача не логирует тела вопросов — только id и количество.

use std::time::Duration;

use serde_json::json;

use crate::{db, AppState};

/// Раз в секунду: пометить истёкшие вопросы и опубликовать `question.expired`.
/// Раз в минуту: удалить вопросы старше `expiresAt + 24 ч`.
pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut purges = 0u64;
    loop {
        tick.tick().await;
        match db::expire_questions(&state.db).await {
            Ok(ids) => {
                for id in ids {
                    tracing::info!(question = %id, "вопрос истёк по TTL");
                    let event = json!({ "type": "question.expired", "at": db::now_iso(), "questionId": id });
                    let _ =
                        db::record_event(&state.db, "question.expired", Some(&id), &event).await;
                    state.publish(event);
                }
            }
            Err(error) => tracing::error!(error = %error, "TTL: истёкшие не помечены"),
        }
        purges += 1;
        if purges % 60 == 0 {
            match db::purge(&state.db, 24).await {
                Ok(removed) if removed > 0 => tracing::info!(removed, "TTL: старые данные удалены"),
                Ok(_) => {}
                Err(error) => tracing::error!(error = %error, "TTL: очистка не удалась"),
            }
        }
    }
}
