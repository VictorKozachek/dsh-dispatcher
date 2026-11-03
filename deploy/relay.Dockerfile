# Релей DSH (relay/, задача 017) в контейнере: multi-stage, без Rust-тулчейна в runtime.
FROM rust:1.82-slim AS builder
WORKDIR /src
# Кешируем зависимости отдельно от исходников.
COPY relay/Cargo.toml relay/Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY relay/src ./src
COPY relay/migrations ./migrations
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home relay \
    && mkdir -p /data && chown relay:relay /data
COPY --from=builder /src/target/release/dsh-relay /usr/local/bin/dsh-relay
USER relay
ENV RELAY_BIND=0.0.0.0:8080 \
    RELAY_DATABASE_URL=sqlite:///data/relay.db?mode=rwc
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS -H 'X-Relay-Version: 1' http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/dsh-relay"]
