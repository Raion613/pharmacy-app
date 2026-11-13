-- 既にある DB（手元・公開版）に足す分。schema.sql の inquiries.rp_no・drug_code と同じ。
-- 今ある残薬調整の照会は、「疑義照会で減らした」剤が1つだけならその剤を指す（ほかは処方全体のまま）
--   手元：npx wrangler d1 execute pharmacy --local --file=db/migrations/2026-11-13-inquiry-target.sql
--   公開版：npx wrangler d1 execute pharmacy --remote --file=db/migrations/2026-11-13-inquiry-target.sql
ALTER TABLE inquiries ADD COLUMN rp_no INTEGER;
ALTER TABLE inquiries ADD COLUMN drug_code TEXT;
UPDATE inquiries SET rp_no = (SELECT r.rp_no FROM prescription_rps r WHERE r.prescription_id = inquiries.prescription_id AND r.days_change = 'inquiry')
 WHERE kind = 'leftover'
   AND (SELECT COUNT(*) FROM prescription_rps r WHERE r.prescription_id = inquiries.prescription_id AND r.days_change = 'inquiry') = 1;
