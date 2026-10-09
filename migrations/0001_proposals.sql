CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('proposed','consented','listed','declined')),
  project TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  relationship TEXT NOT NULL,
  work TEXT,
  policy_url TEXT,
  submitted_by TEXT NOT NULL,
  consent_url TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals (status, created_at);
