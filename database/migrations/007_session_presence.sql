-- Track recent activity for accurate concurrent online-user counts.
-- Old sessions remain null until they send a heartbeat after deployment.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
CREATE INDEX IF NOT EXISTS sessions_company_presence_idx
  ON sessions (company_id, last_seen_at)
  WHERE revoked_at IS NULL;
