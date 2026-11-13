-- 既にある DB（手元・公開版）に足す分。schema.sql の adopted_drugs・drug_stock と同じ。
-- デモの薬局（id 1）の採用薬（seed-demo.js の ADOPTED と同じ）と、全部の薬局・全部の薬の在庫 100 も入れる
--   手元：npx wrangler d1 execute pharmacy --local --file=db/migrations/2026-11-13-adopted-drugs.sql
--   公開版：npx wrangler d1 execute pharmacy --remote --file=db/migrations/2026-11-13-adopted-drugs.sql
CREATE TABLE IF NOT EXISTS adopted_drugs (
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  drug_code   TEXT NOT NULL,
  adopted_at  TEXT NOT NULL,
  adopted_by  INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (pharmacy_id, drug_code)
);
INSERT OR IGNORE INTO adopted_drugs (pharmacy_id, drug_code, adopted_at, adopted_by)
  SELECT 1, code, '2026-04-01T00:00:00.000Z', 1 FROM drugs
   WHERE code IN ('620007870', '622588801', '620009465', '622098501', '610463198', '620002023');
CREATE TABLE IF NOT EXISTS drug_stock (
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  drug_code   TEXT NOT NULL,
  qty_milli   INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (pharmacy_id, drug_code)
);
INSERT OR IGNORE INTO drug_stock (pharmacy_id, drug_code, qty_milli, updated_at)
  SELECT p.id, d.code, 100000, '2026-11-13T00:00:00.000Z' FROM pharmacies p CROSS JOIN drugs d;
