-- 既にある DB（手元・公開版）に足す分。schema.sql の prescription_revisions と、指導記録の手帳の欄を外す分。
--   手元：npx wrangler d1 execute pharmacy --local --file=db/migrations/2026-11-13-rx-revisions.sql
--   公開版：npx wrangler d1 execute pharmacy --remote --file=db/migrations/2026-11-13-rx-revisions.sql
CREATE TABLE prescription_revisions (
  id              INTEGER PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  before_json     TEXT NOT NULL,
  summary         TEXT NOT NULL,
  content_changed INTEGER NOT NULL CHECK (content_changed IN (0, 1)),
  received_yen    INTEGER,
  created_at      TEXT NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_prescription_revisions_rx ON prescription_revisions(prescription_id, id);
ALTER TABLE guidance_records DROP COLUMN notebook;
