# Cursor Notes for jira-qa-server

- This is a small Express server.
- It fetches Jira issues from a Jira Cloud board using Agile API.
- It also stores per-issue QA state (AC and DoD) into PostgreSQL.
- Table: qa_states (issue_key TEXT PK, ac JSONB, dod JSONB, updated_at TIMESTAMP).
- Frontend is a single HTML file: qa-ui.html, it calls:
  - GET /api/jira-sprint-issues
  - GET /api/qa-state/:issueKey
  - POST /api/qa-state/:issueKey
- When editing, keep the API contract with qa-ui.html.
