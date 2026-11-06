// 薬局の区別：他の薬局の患者・処方・受付などは、一覧に出ず、ID を指定しても 404 になる
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { assertPatient, assertPrescription, assertReception, assertBodyPatient } from "../src/server/tenant.js";
import { createPatient, searchPatients } from "../src/server/patients.js";
import { createTemplate, templatesOf } from "../src/server/records.js";
import { createFacility, homeOverview } from "../src/server/homecare.js";
import { createReception, receptionsOn } from "../src/server/reception.js";
import { receiveMessage, threads } from "../src/server/line.js";
import { todayJst } from "../src/server/http.js";

const FIXTURE = `
INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES
  (1, 'A薬局', '13', '9999999', '100-0000', '架空', '000'), (2, 'B薬局', '20', '9999998', '386-0000', '架空', '000');
INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES
  (1, 1, 'a', 'A 薬剤師', 'x', 'x', 1), (2, 2, 'b', 'B 薬剤師', 'x', 'x', 1);
INSERT INTO patients (id, pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by) VALUES
  (1, 1, '000001', '架空　太郎', 'カクウ　タロウ', '1960-01-01', 'M', 30, '2026-01-01T00:00:00Z', 1);
INSERT INTO prescriptions (id, patient_id, prescribed_on, dispensed_on, handbook, drug_points, total_points, burden_percent, copay_yen, created_at, created_by)
  VALUES ('rx-1', 1, '2026-10-01', '2026-10-01', 'paper', 7, 7, 30, 20, '2026-10-01T01:00:00Z', 1);
`;

const A = { id: 1, pharmacy_id: 1 };
const B = { id: 2, pharmacy_id: 2 };
let db;
beforeEach(() => {
  db = openD1("db/schema.sql");
  db.exec(FIXTURE);
});

const is404 = (e) => e.status === 404;

test("他の薬局の患者・処方・受付は、ID を指定しても 404", async () => {
  await assertPatient(db, A, 1);
  await assert.rejects(assertPatient(db, B, 1), is404);
  await assert.rejects(assertPrescription(db, B, "rx-1"), is404);
  await assert.rejects(assertBodyPatient(db, B, { patientId: 1 }), is404);
  const { id } = await createReception(db, A, { patientId: 1 });
  await assertReception(db, A, id);
  await assert.rejects(assertReception(db, B, id), is404);
});

test("患者の一覧と番号は薬局ごと", async () => {
  const b1 = await createPatient(db, B, { name: "上田　一郎", kana: "ウエダ　イチロウ", birthDate: "1960-05-05", sex: "M", burdenPercent: 30 });
  assert.equal(b1.patientNo, "000001"); // A薬局にも 000001 がいるが、薬局が違えば同じ番号でよい
  assert.deepEqual((await searchPatients(db, 1, "")).map((p) => p.id), [1]);
  assert.deepEqual((await searchPatients(db, 2, "")).map((p) => p.id), [b1.id]);
  assert.deepEqual(await searchPatients(db, 2, "カクウ"), []);
});

test("テンプレート・施設は薬局ごと（同じ名前も別の薬局なら作れる）", async () => {
  await createTemplate(db, A, { title: "定期", plan: "継続" });
  await createTemplate(db, B, { title: "定期", plan: "継続" });
  assert.equal((await templatesOf(db, 1)).length, 1);
  await createFacility(db, A, { name: "ひだまりホーム", address: "a", phone: "b" });
  await createFacility(db, B, { name: "ひだまりホーム", address: "a", phone: "b" });
  assert.equal((await homeOverview(db, 2, "2026-11")).facilities.length, 1);
  assert.deepEqual((await homeOverview(db, 2, "2026-11")).pharmacists.map((p) => p.id), [2]);
});

test("受付状況・つながる薬局の一覧に他の薬局の患者は出ない", async () => {
  await createReception(db, A, { patientId: 1 });
  await receiveMessage(db, A, { patientId: 1, body: "こんにちは" });
  assert.equal((await receptionsOn(db, 1, todayJst())).length, 1);
  assert.equal((await receptionsOn(db, 2, todayJst())).length, 0);
  assert.equal((await threads(db, 1)).length, 1);
  assert.equal((await threads(db, 2)).length, 0);
});
