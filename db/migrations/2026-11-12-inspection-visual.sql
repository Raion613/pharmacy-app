-- 既にある DB（手元・公開版）に足す分。schema.sql の inspection_visual_checks と同じ
--   手元：npx wrangler d1 execute pharmacy --local --file=db/migrations/2026-11-12-inspection-visual.sql
--   公開版：npx wrangler d1 execute pharmacy --remote --file=db/migrations/2026-11-12-inspection-visual.sql
CREATE TABLE IF NOT EXISTS inspection_visual_checks (
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  drug_code     TEXT NOT NULL,
  PRIMARY KEY (inspection_id, drug_code)
);
