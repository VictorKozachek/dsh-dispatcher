-- Начальная схема релея (протокол v1, задача 017).

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    public_key TEXT NOT NULL,
    push_token TEXT,
    label TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_identity ON devices (platform, public_key);
CREATE INDEX IF NOT EXISTS devices_token ON devices (token_hash);

CREATE TABLE IF NOT EXISTS pairing_codes (
    code TEXT PRIMARY KEY,
    device_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    short_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    answered INTEGER NOT NULL DEFAULT 0,
    expired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS questions_created ON questions (created_at);
CREATE INDEX IF NOT EXISTS questions_expires ON questions (expires_at);

CREATE TABLE IF NOT EXISTS answers (
    question_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    answered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    question_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
);
