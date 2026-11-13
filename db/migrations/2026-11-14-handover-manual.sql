-- 引き継ぎの「S・O・A を書いた」「次回の P を書いた」も押して付ける（2026-11-14）。項目の CHECK を広げるため表を作り直す
--   手元：npx wrangler d1 execute pharmacy --local --file=db/migrations/2026-11-14-handover-manual.sql
--   公開版：npx wrangler d1 execute pharmacy --remote --file=db/migrations/2026-11-14-handover-manual.sql
CREATE TABLE handover_checks_new (
  id              INTEGER PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  item            TEXT NOT NULL CHECK (item IN ('plan', 'cautions', 'change', 'soa', 'nextp')),
  checked         INTEGER NOT NULL CHECK (checked IN (0, 1)),
  at              TEXT NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id)
);
INSERT INTO handover_checks_new SELECT id, prescription_id, item, checked, at, user_id FROM handover_checks;
DROP TABLE handover_checks;
ALTER TABLE handover_checks_new RENAME TO handover_checks;
CREATE INDEX idx_handover_checks_rx ON handover_checks(prescription_id, id);
