-- Messages: metadata only, content is never stored
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT    PRIMARY KEY,
  match_id      TEXT    NOT NULL,
  sender_id     TEXT    NOT NULL,
  receiver_id   TEXT    NOT NULL,
  type          TEXT    NOT NULL CHECK(type IN ('text','emoji','gif','photo','voice')),
  content_hash  TEXT,
  timestamp     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  delivered     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_messages_match    ON messages(match_id, timestamp);
CREATE INDEX idx_messages_receiver ON messages(receiver_id, delivered);

