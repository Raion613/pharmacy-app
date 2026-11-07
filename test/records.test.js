// 患者メモと指導記録（SOAP）の検証・保存・薬歴への組み込み
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { createNotes, updateNote, createRecord, notesOf } from "../src/server/records.js";
import { prescriptionsOf } from "../src/server/prescriptions.js";
import { getPatient, searchPatients } from "../src/server/patients.js";
import { HttpError } from "../src/server/http.js";

const FIXTURE = `
INSERT INTO master_imports VALUES (1, 'drug', 'full', '2026-03-19', 'test.csv', 1, 1, '2026-03-19T00:00:00Z', NULL, 'p1');
INSERT INTO drugs (code, yj_code, name, unit, generic, general_name, sentei, pair_code, narcotic, name_key, general_key, attrs_published_on)
  VALUES ('610000001', '1111111F1011', '試験錠', '錠', 0, NULL, 0, NULL, 0, '試験錠', '', '2026-03-19');
INSERT INTO drug_prices VALUES ('610000001', '2026-04-01', 1, 1000, NULL);
INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'テスト薬局', '13', '9999999', '100-0000', '架空', '000'), (2, '別の薬局', '20', '9999998', '386-0000', '架空', '000');
INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations)
  VALUES (1, 1, 'test', 'テスト 薬剤師', 'x', 'x', 1);
INSERT INTO patients (id, pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by) VALUES
  (1, 1, '000001', '架空　太郎', 'カクウ　タロウ', '1960-01-01', 'M', 30, '2026-01-01T00:00:00Z', 1),
  (2, 1, '000002', '架空　花子', 'カクウ　ハナコ', '1970-01-01', 'F', 30, '2026-01-01T00:00:00Z', 1);
INSERT INTO prescriptions (id, patient_id, prescribed_on, dispensed_on, handbook, drug_points, total_points, burden_percent, copay_yen, created_at, created_by)
  VALUES ('rx-1', 1, '2026-05-01', '2026-05-01', 'paper', 7, 7, 30, 20, '2026-05-01T01:00:00Z', 1);
INSERT INTO prescription_rps (id, prescription_id, rp_no, usage, rx_days, days, daily_yen, points_per_day, points) VALUES ('rp-1', 'rx-1', 1, '1日1回朝食後', 7, 7, '10.00', 1, 7);
INSERT INTO prescription_items (rp_id, line_no, drug_code, daily_qty_milli, price_sen) VALUES ('rp-1', 1, '610000001', 1000, 1000);
`;

let db;
beforeEach(() => {
  db = openD1("db/schema.sql");
  db.exec(FIXTURE);
});

const user = { id: 1, pharmacy_id: 1 };
const pathsOf = async (promise) => {
  try {
    await promise;
    return [];
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.details.map((d) => d.path);
  }
};
const createNote = (d, u, patientId, note) => createNotes(d, u, patientId, { notes: [note] });
const count = async (table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

test("患者メモ：分類と内容を検証する", async () => {
  assert.deepEqual(await pathsOf(createNote(db, user, 1, { category: "unknown", body: "" })), ["category", "body"]);
  assert.deepEqual(await pathsOf(createNote(db, user, 1, { category: "toString", body: "x" })), ["category"]);
  assert.deepEqual(await pathsOf(createNote(db, user, 1, { category: "allergy", body: "あ".repeat(301) })), ["body"]);
  await assert.rejects(createNote(db, user, 99, { category: "allergy", body: "x" }), (e) => e.status === 404);
  assert.equal(await count("patient_notes"), 0);
});

test("患者メモ：保存するとアクセスログも残り、新しい順に返る", async () => {
  await createNote(db, user, 1, { category: "allergy", body: "  セフェム系で発疹  " });
  await createNote(db, user, 1, { category: "handover", body: "説明は短く" });
  const notes = await notesOf(db, 1);
  assert.deepEqual(notes.map((n) => [n.category, n.body]), [["handover", "説明は短く"], ["allergy", "セフェム系で発疹"]]);
  const logs = await db.prepare("SELECT action, patient_id, detail FROM access_logs ORDER BY id").all();
  assert.deepEqual(logs.results.map((l) => l.detail), ["アレルギー歴", "申し送り"]);
  assert.ok(logs.results.every((l) => l.action === "note.create" && l.patient_id === 1));
});

test("アレルギー歴・副作用歴のメモがある患者は、一覧と詳細に注意の分類が付く", async () => {
  await createNote(db, user, 1, { category: "allergy", body: "セフェム系で発疹" });
  await createNote(db, user, 1, { category: "lifestyle", body: "喫煙" });
  assert.deepEqual((await getPatient(db, 1)).alertCategories, ["allergy"]);
  const list = await searchPatients(db, 1, "カクウ");
  assert.deepEqual(list.map((p) => [p.patientNo, p.alertCategories]), [["000001", ["allergy"]], ["000002", []]]);
});

test("患者メモ：1件ずつ分けてまとめて登録する（同じ分類を何件でも）", async () => {
  await createNotes(db, user, 1, { notes: [{ category: "allergy", body: "セフェム系で発疹" }, { category: "allergy", body: "卵" }] });
  assert.deepEqual((await notesOf(db, 1)).map((n) => n.body).sort(), ["セフェム系で発疹", "卵"]);
});

test("患者メモ：直すと今の内容が変わり、直す前の内容は履歴に残る。直せるのは今の内容だけ", async () => {
  const [first] = await createNote(db, user, 1, { category: "concomitant", body: "ロキソプロフェン" });
  const fixed = await updateNote(db, user, 1, first.id, { category: "concomitant", body: "ロキソプロフェン（整形外科、頓用）" });
  const again = await updateNote(db, user, 1, fixed.id, { category: "adverse", body: "ロキソプロフェンで胃痛" });
  const notes = await notesOf(db, 1);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].category, notes[0].body], ["adverse", "ロキソプロフェンで胃痛"]);
  assert.deepEqual(notes[0].history.map((h) => h.body), ["ロキソプロフェン（整形外科、頓用）", "ロキソプロフェン"]);
  assert.equal(again.id, notes[0].id);
  assert.equal(await count("patient_notes"), 3); // 書き換えずに足している
  assert.deepEqual(await pathsOf(updateNote(db, user, 1, first.id, { category: "allergy", body: "x" })), ["body"]); // 直し済みの古い内容は直せない
  assert.deepEqual(await pathsOf(updateNote(db, user, 1, notes[0].id, { category: "allergy", body: " " })), ["body"]);
  await assert.rejects(updateNote(db, user, 2, notes[0].id, { category: "allergy", body: "x" }), (e) => e.status === 404); // 別の患者のメモ
  const logs = await db.prepare("SELECT action FROM access_logs ORDER BY id").all();
  assert.deepEqual(logs.results.map((l) => l.action), ["note.create", "note.update", "note.update"]);
});

test("患者メモ：直してアレルギー歴でなくなれば、注意の分類からも外れる", async () => {
  const [n] = await createNote(db, user, 1, { category: "allergy", body: "卵" });
  await updateNote(db, user, 1, n.id, { category: "lifestyle", body: "卵は食べられる（聞き違い）" });
  assert.deepEqual((await getPatient(db, 1)).alertCategories, []);
});

const soap = (overrides = {}) => ({
  subjective: "", objective: "", assessment: "", plan: "", leftover: "none", notebook: "used", ...overrides,
});

test("指導記録：S・O・A・P のどれも空なら保存しない。残薬と手帳は選択肢から", async () => {
  assert.deepEqual(await pathsOf(createRecord(db, user, "rx-1", soap())), ["subjective"]);
  assert.deepEqual(await pathsOf(createRecord(db, user, "rx-1", soap({ plan: "x", leftover: "x", notebook: undefined }))), ["leftover", "notebook"]);
  assert.deepEqual(await pathsOf(createRecord(db, user, "rx-1", soap({ objective: "あ".repeat(1001) }))), ["objective"]);
  await assert.rejects(createRecord(db, user, "rx-x", soap({ plan: "x" })), (e) => e.status === 404);
  assert.equal(await count("guidance_records"), 0);
});

test("指導記録：処方にひも付き、薬歴の来局ごとに新しい順で入る", async () => {
  const r = await createRecord(db, user, "rx-1", soap({ subjective: "眠い", plan: "次回確認" }));
  assert.equal(r.patientId, 1);
  await createRecord(db, user, "rx-1", soap({ plan: "追記", leftover: "some" }));
  const [rx] = await prescriptionsOf(db, 1);
  assert.deepEqual(rx.records.map((g) => [g.plan, g.leftover]), [["追記", "some"], ["次回確認", "none"]]);
  assert.equal(rx.records[1].subjective, "眠い");
  assert.equal(rx.records[0].createdBy, "テスト 薬剤師");
  const log = await db.prepare("SELECT action, patient_id FROM access_logs ORDER BY id DESC").first();
  assert.deepEqual(log, { action: "record.create", patient_id: 1 });
});

test("指導記録の無い来局は、記録が空の配列になる", async () => {
  const [rx] = await prescriptionsOf(db, 1);
  assert.deepEqual(rx.records, []);
});
