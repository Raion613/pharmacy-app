// 回覧板：本部の投稿は全部の薬局に出る。薬局の投稿はその薬局だけ。確認した人は、その薬局の人の分だけ見える
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { HttpError } from "../src/server/http.js";
import { listNotices, unreadCount, createNotice, markRead } from "../src/server/notices.js";

const FIXTURE = `
INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'テスト薬局', '13', '9999999', '100-0000', '架空', '000'), (2, '別の薬局', '20', '9999998', '386-0000', '架空', '000');
INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES
  (1, 1, 'a', 'A 薬剤師', 'x', 'x', 1), (2, 1, 'b', 'B 薬剤師', 'x', 'x', 1), (3, 2, 'c', 'C 薬剤師', 'x', 'x', 1);
INSERT INTO notices (id, pharmacy_id, kind, body, sender, created_at, created_by) VALUES (1, NULL, 'hq', '全店へ', '本部 薬事部', '2026-11-01T00:00:00Z', NULL);
`;

let db;
beforeEach(() => {
  db = openD1("db/schema.sql");
  db.exec(FIXTURE);
});
const a = { id: 1, pharmacy_id: 1 }, b = { id: 2, pharmacy_id: 1 }, c = { id: 3, pharmacy_id: 2 };
const paths = async (p) => {
  try {
    await p;
    return [];
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.details.map((d) => d.path);
  }
};

test("投稿：種類は申し送り・報告・連絡・相談だけ。空・長すぎは項目ごとに返す。書いた人は確認済み", async () => {
  assert.deepEqual(await paths(createNotice(db, a, { kind: "hq", body: "x" })), ["kind"]);
  assert.deepEqual(await paths(createNotice(db, a, { kind: "handover", body: "  \n " })), ["body"]);
  assert.deepEqual(await paths(createNotice(db, a, { kind: "report", body: "あ".repeat(1001) })), ["body"]);
  const id = await createNotice(db, a, { kind: "handover", body: "午後へ：分包紙の補充\r\n" });
  const mine = (await listNotices(db, a)).notices.find((n) => n.id === id);
  assert.deepEqual([mine.body, mine.author, mine.mine, mine.read, mine.readBy], ["午後へ：分包紙の補充", "A 薬剤師", true, true, ["A 薬剤師"]]);
  const log = await db.prepare("SELECT action, patient_id FROM access_logs").all();
  assert.deepEqual(log.results, [{ action: "notice.create", patient_id: null }]);
});

test("見える範囲：本部の投稿は全部の薬局、薬局の投稿はその薬局だけ。他の薬局の投稿は確認できない", async () => {
  const id = await createNotice(db, a, { kind: "contact", body: "テスト薬局の中だけ" });
  assert.deepEqual((await listNotices(db, b)).notices.map((n) => n.id), [id, 1]);
  assert.deepEqual((await listNotices(db, c)).notices.map((n) => n.id), [1]);
  await assert.rejects(markRead(db, c, id), (e) => e.status === 404);
});

test("確認した：1人1回。数は自分の分だけ減る。本部の投稿の判子は、自分の薬局の人の分だけ見える", async () => {
  assert.equal(await unreadCount(db, b), 1);
  await markRead(db, b, 1);
  await markRead(db, b, 1);
  await markRead(db, c, 1);
  assert.equal(await unreadCount(db, b), 0);
  assert.equal(await unreadCount(db, a), 1);
  const hq = (await listNotices(db, a)).notices[0];
  assert.deepEqual([hq.fromHq, hq.author, hq.read, hq.readBy], [true, "本部 薬事部", false, ["B 薬剤師"]]);
  assert.equal((await listNotices(db, a)).staff, 2);
});
