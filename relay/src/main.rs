//! Точка входа релея DSH: конфигурация, логи, HTTP-сервер, TTL-задачи.

use dsh_relay::{app, ttl, AppState, Config};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let config = Config::from_env()?;
    let bind = config.bind.clone();
    let state = AppState::new(config).await?;
    tokio::spawn(ttl::run(state.clone()));

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(bind = %bind, "релей слушает");
    axum::serve(listener, app(state)).await?;
    Ok(())
}
