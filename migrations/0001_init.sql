CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL,
  account_id TEXT, email TEXT, client_id TEXT, client_name TEXT, tool TEXT,
  outcome TEXT NOT NULL, error_code TEXT, result_count INTEGER, recipient_count INTEGER, message_id TEXT
);
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_account ON audit_log (account_id, at);
CREATE TABLE blocked_accounts (key TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE pending_approvals (
  handle_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, email TEXT NOT NULL, client_id TEXT NOT NULL,
  client_name TEXT NOT NULL, redirect_host TEXT NOT NULL, created_at INTEGER NOT NULL
);
