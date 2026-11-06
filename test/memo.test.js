// メモ帳：書き換えると新しい行を足し、前の内容は消さない。同じ内容なら足さない
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { memoOf, saveMemo } from "../src/server/memo.js";

let db;
beforeEach(() => {
  db = openD1("db/schema.sql");
  db.exec(`
    INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'A薬局', '13', '9999999', '100-0000', '架空', '000');
    INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES (1, 1, 'a', 'A 薬剤師', 'x', 'x', 1);
    INSERT INTO patients (id, pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by)
      VALUES (1, 1, '000001', '架空　太郎', 'カクウ　タロウ', '1960-01-01', 'M', 30, '2026-01-01T00:00:00Z', 1);`);
});
const user = { id: 1, pharmacy_id: 1 };
const rows = () => db.prepare("SELECT body FROM patient_memos ORDER BY id").all().then((r) => r.results.map((x) => x.body));

test("書き換えると最新の内容になり、前の内容は行として残る。同じ内容では足さない", async () => {
  assert.deepEqual(await memoOf(db, 1), { body: "", updatedAt: null, updatedBy: null });
  await saveMemo(db, user, 1, { body: "妻と二人暮らし\n娘が月1回来る" });
  await saveMemo(db, user, 1, { body: "妻と二人暮らし\n娘が月1回来る" });
  const m = await saveMemo(db, user, 1, { body: "妻と二人暮らし\n娘が週1回来る\r\n" });
  assert.equal(m.body, "妻と二人暮らし\n娘が週1回来る");
  assert.equal(m.updatedBy, "A 薬剤師");
  assert.deepEqual(await rows(), ["妻と二人暮らし\n娘が月1回来る", "妻と二人暮らし\n娘が週1回来る"]);
  const logs = await db.prepare("SELECT action FROM access_logs").all();
  assert.deepEqual(logs.results.map((l) => l.action), ["memo.update", "memo.update"]);
});

test("2000文字を超えると保存しない", async () => {
  await assert.rejects(saveMemo(db, user, 1, { body: "あ".repeat(2001) }), (e) => e.status === 422);
  assert.deepEqual(await rows(), []);
});
