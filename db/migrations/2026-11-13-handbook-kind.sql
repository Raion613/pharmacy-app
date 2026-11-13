-- 既にある DB（手元・公開版）に足す分。schema.sql の patients.handbook_kind と同じ。前回の処方の提示から埋める
--   手元：npx wrangler d1 execute pharmacy --local --file=db/migrations/2026-11-13-handbook-kind.sql
--   公開版：npx wrangler d1 execute pharmacy --remote --file=db/migrations/2026-11-13-handbook-kind.sql
ALTER TABLE patients ADD COLUMN handbook_kind TEXT CHECK (handbook_kind IN ('paper', 'electronic', 'none'));
UPDATE patients SET handbook_kind = (
  SELECT COALESCE(
    (SELECT handbook FROM prescriptions WHERE patient_id = patients.id AND handbook <> 'none' ORDER BY dispensed_on DESC, created_at DESC LIMIT 1),
    (SELECT 'none' FROM prescriptions WHERE patient_id = patients.id LIMIT 1)));
