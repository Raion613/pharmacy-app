// 公費：窓口の額の計算（国の公費 → 自治体の助成、月の上限と管理票の累計）と、受給者証の登録
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyKohi } from "../src/rules/kohi.js";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { createKohi, kohiForPrescription } from "../src/server/kohi.js";
import { HttpError } from "../src/server/http.js";

// 合計 1,234点 → 医療費 12,340円。3割の一部負担金は 3,702円 → 3,700円
const base = { totalPoints: 1234, burdenPercent: 30, copayYen: 3700 };

test("公費なし：窓口は一部負担金のまま", () => {
  assert.equal(applyKohi({ ...base, kohi: [] }).patientPayYen, 3700);
});

test("精神通院：医療費の1割（10円未満四捨五入）。月の上限は管理票の累計を引いた残りまで", () => {
  const r = applyKohi({ ...base, kohi: [{ id: 1, kind: "mental", capYen: 5000, priorMonthYen: 0 }] });
  assert.equal(r.patientPayYen, 1230); // 12,340 × 1割 = 1,234 → 1,230
  assert.equal(r.steps[0].monthTotalYen, 1230);
  const capped = applyKohi({ ...base, kohi: [{ id: 1, kind: "mental", capYen: 5000, priorMonthYen: 4500 }] });
  assert.deepEqual([capped.patientPayYen, capped.steps[0].monthTotalYen], [500, 5000]);
  const reached = applyKohi({ ...base, kohi: [{ id: 1, kind: "mental", capYen: 5000, priorMonthYen: 5000 }] });
  assert.equal(reached.patientPayYen, 0);
  const noCap = applyKohi({ ...base, kohi: [{ id: 1, kind: "mental", capYen: null, priorMonthYen: null }] });
  assert.deepEqual([noCap.patientPayYen, noCap.steps[0].monthTotalYen], [1230, null]);
});

test("難病：2割。保険の割合がそれより低ければ保険の割合", () => {
  assert.equal(applyKohi({ ...base, kohi: [{ id: 1, kind: "nanbyo", capYen: 10000, priorMonthYen: 0 }] }).patientPayYen, 2470); // 2,468 → 2,470
  const late = { totalPoints: 1234, burdenPercent: 10, copayYen: 1230 };
  assert.equal(applyKohi({ ...late, kohi: [{ id: 1, kind: "nanbyo", capYen: 10000, priorMonthYen: 0 }] }).patientPayYen, 1230);
});

test("自治体の助成：無料・1回いくら・月の上限。国の公費を先にかける", () => {
  const kid = { totalPoints: 500, burdenPercent: 20, copayYen: 1000 };
  assert.equal(applyKohi({ ...kid, kohi: [{ id: 1, kind: "local", localForm: "free", capYen: null }] }).patientPayYen, 0);
  assert.equal(applyKohi({ ...kid, kohi: [{ id: 1, kind: "local", localForm: "perVisit", perVisitYen: 200, capYen: null }] }).patientPayYen, 200);
  assert.equal(applyKohi({ ...kid, kohi: [{ id: 1, kind: "local", localForm: "cap", capYen: 1000, priorMonthYen: 800 }] }).patientPayYen, 200);
  // 渡す順が逆でも、精神通院 → 自治体 の順でかかる
  const both = applyKohi({ ...base, kohi: [{ id: 2, kind: "local", localForm: "perVisit", perVisitYen: 500, capYen: null }, { id: 1, kind: "mental", capYen: 5000, priorMonthYen: 0 }] });
  assert.deepEqual(both.steps.map((s) => [s.id, s.payYen]), [[1, 1230], [2, 500]]);
});

const FIXTURE = `
INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'テスト薬局', '13', '9999999', '100-0000', '架空', '000');
INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES (1, 1, 'test', 'テスト', 'x', 'x', 1);
INSERT INTO patients (id, pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by)
  VALUES (1, 1, '000001', '架空　太郎', 'カクウ　タロウ', '1980-01-01', 'M', 30, '2026-01-01T00:00:00Z', 1);
`;
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

test("受給者証の登録：法別番号と番号の桁、有効期間、自治体の助成の形", async () => {
  const db = openD1("db/schema.sql");
  db.exec(FIXTURE);
  const ok = { kind: "mental", payerNo: "21130019", recipientNo: "1234567", capYen: 5000, validFrom: "2026-04-01", validUntil: "2027-03-31" };
  assert.deepEqual(await pathsOf(createKohi(db, user, 1, { ...ok, payerNo: "54130019" })), ["payerNo"]);
  assert.deepEqual(await pathsOf(createKohi(db, user, 1, { ...ok, recipientNo: "123" })), ["recipientNo"]);
  assert.deepEqual(await pathsOf(createKohi(db, user, 1, { ...ok, validUntil: "2026-01-01" })), ["validUntil"]);
  assert.deepEqual(await pathsOf(createKohi(db, user, 1, { kind: "local", payerNo: "88132019", recipientNo: "55", validFrom: "2026-04-01", validUntil: "2027-03-31", localForm: "perVisit" })), ["localName", "perVisitYen"]);
  const k = await createKohi(db, user, 1, ok);
  assert.equal(k.capYen, 5000);

  // 処方に使う：有効期間内で、月の上限のある公費は管理票の累計が要る
  assert.deepEqual(await pathsOf(kohiForPrescription(db, 1, "2026-11-07", [{ kohiId: k.id }])), ["kohi.0.priorMonthYen"]);
  assert.deepEqual(await pathsOf(kohiForPrescription(db, 1, "2027-04-01", [{ kohiId: k.id, priorMonthYen: 0 }])), ["kohi.0"]);
  assert.deepEqual(await pathsOf(kohiForPrescription(db, 1, "2026-11-07", [{ kohiId: 999, priorMonthYen: 0 }])), ["kohi.0"]);
  const [used] = await kohiForPrescription(db, 1, "2026-11-07", [{ kohiId: k.id, priorMonthYen: 2500 }]);
  assert.equal(used.priorMonthYen, 2500);
});
