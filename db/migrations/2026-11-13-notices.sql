-- 既にある DB（手元・公開版）に足す分。schema.sql の notices・notice_reads と同じ。デモの投稿も入れる（seed-demo.js の NOTICES と同じ）
--   手元：npx wrangler d1 execute pharmacy --local --file=db/migrations/2026-11-13-notices.sql
--   公開版：npx wrangler d1 execute pharmacy --remote --file=db/migrations/2026-11-13-notices.sql
CREATE TABLE IF NOT EXISTS notices (
  id          INTEGER PRIMARY KEY,
  pharmacy_id INTEGER REFERENCES pharmacies(id),
  kind        TEXT NOT NULL CHECK (kind IN ('hq', 'periodic', 'pr', 'handover', 'report', 'contact', 'consult')),
  body        TEXT NOT NULL,
  sender      TEXT,
  created_at  TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_notices_pharmacy ON notices(pharmacy_id, id);
CREATE TABLE IF NOT EXISTS notice_reads (
  notice_id INTEGER NOT NULL REFERENCES notices(id),
  user_id   INTEGER NOT NULL REFERENCES users(id),
  read_at   TEXT NOT NULL,
  PRIMARY KEY (notice_id, user_id)
);
INSERT OR IGNORE INTO notices (id, pharmacy_id, kind, sender, created_by, created_at, body) VALUES (1, NULL, 'hq', '本部 薬事部', NULL, '2026-11-04T00:30:00.000Z', '11月1日から一部の品目の薬価が変わっています（年度の途中の変更）。
各店で「マスター取込」に最新の改定分（.csv）を取り込み、調剤日が11月1日以降の処方で金額が新しくなっていることを確かめてください。');
INSERT OR IGNORE INTO notices (id, pharmacy_id, kind, sender, created_by, created_at, body) VALUES (2, NULL, 'periodic', '本部 営業部', NULL, '2026-11-05T08:00:00.000Z', '10月の月報を出しました。今月から、店ごとの後発医薬品の使用割合も並べています。
自店の数字は左のメニューの「薬局の数字」で見られます。');
INSERT OR IGNORE INTO notices (id, pharmacy_id, kind, sender, created_by, created_at, body) VALUES (3, NULL, 'pr', '本部 広報', NULL, '2026-11-10T01:00:00.000Z', 'インフルエンザの流行期に入りました 🍵
待合のポスターを11月版に差し替えます。今週中に各店へ届きます。古いポスターは外して捨ててください。');
INSERT OR IGNORE INTO notices (id, pharmacy_id, kind, sender, created_by, created_at, body) VALUES (4, 1, 'handover', NULL, 2, '2026-11-12T04:05:00.000Z', '午前→午後の申し送りです。
・卸の午後便で、在庫が切れていた錠剤が入ります。届いたら棚の補充をお願いします
・14時ごろ、近くのクリニックから処方日数の件で折り返しの電話があります（内容は薬歴に書きました）');
INSERT OR IGNORE INTO notices (id, pharmacy_id, kind, sender, created_by, created_at, body) VALUES (5, 1, 'contact', NULL, 1, '2026-11-12T09:10:00.000Z', '分包紙の在庫が残り1箱です。明日の発注に入れました。');
INSERT OR IGNORE INTO notices (id, pharmacy_id, kind, sender, created_by, created_at, body) VALUES (6, 1, 'consult', NULL, 2, '2026-11-13T00:12:00.000Z', '年末年始の営業時間の貼り紙、去年の文面を使い回してもいいでしょうか？ 休みの日は本部の案内（12/29〜1/3）のとおりです。');
INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (1, 1, '2026-11-04T01:00:00.000Z');
INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (2, 1, '2026-11-05T09:00:00.000Z');
INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (4, 1, '2026-11-12T04:30:00.000Z');
INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (5, 1, '2026-11-12T09:10:00.000Z');
INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (1, 2, '2026-11-04T02:00:00.000Z');
INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (3, 2, '2026-11-10T02:00:00.000Z');
INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (4, 2, '2026-11-12T04:05:00.000Z');
INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (5, 2, '2026-11-13T00:05:00.000Z');
INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (6, 2, '2026-11-13T00:12:00.000Z');
