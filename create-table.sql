CREATE TABLE IF NOT EXISTS qa_states (
  issue_key TEXT PRIMARY KEY,
  ac JSONB DEFAULT '[]'::jsonb,
  dod JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMP DEFAULT NOW()
);
