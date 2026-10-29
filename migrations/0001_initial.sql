PRAGMA foreign_keys = ON;
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE channels (
  platform TEXT NOT NULL CHECK(platform IN ('twitch','kick')), broadcaster_id TEXT NOT NULL, slug TEXT NOT NULL,
  live INTEGER NOT NULL DEFAULT 0, stream_key TEXT, title TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL DEFAULT 0, subscription_id TEXT, subscription_checked_at INTEGER NOT NULL DEFAULT 0,
  subscription_status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  PRIMARY KEY(platform,broadcaster_id)
);
CREATE TABLE rules (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, broadcaster_id TEXT NOT NULL, webhook TEXT NOT NULL,
  destination TEXT NOT NULL, message TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, activated_at INTEGER NOT NULL, test_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(platform,broadcaster_id) REFERENCES channels(platform,broadcaster_id)
);
CREATE INDEX rules_owner ON rules(user_id);
CREATE INDEX rules_channel ON rules(platform,broadcaster_id,enabled);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  stream_key TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  sent_at INTEGER, error TEXT, UNIQUE(rule_id,stream_key)
);
CREATE INDEX deliveries_due ON deliveries(state,due_at);
CREATE TABLE leases (name TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
