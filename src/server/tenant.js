// 薬局の区別。URL や送られてきた本文に入っている ID が、ログインした人の薬局のものかを確かめる。
// 他の薬局の行なら「無い」と同じ 404 を返す（他の薬局にその ID の患者がいることも教えない）。
// API は、ID を受け取ったら中身を引く前に必ずここを通す。一覧は各 SQL で pharmacy_id を条件に入れる。
import { HttpError } from "./http.js";

async function assertOwned(db, user, sql, id, message) {
  const row = await db.prepare(sql).bind(id, user.pharmacy_id).first();
  if (!row) throw new HttpError(404, message);
  return row;
}

export function assertPatient(db, user, patientId) {
  return assertOwned(db, user, "SELECT id FROM patients WHERE id = ?1 AND pharmacy_id = ?2", patientId, "患者が見つかりません");
}

export function assertPrescription(db, user, prescriptionId) {
  return assertOwned(db, user,
    "SELECT p.id FROM prescriptions p JOIN patients pa ON pa.id = p.patient_id WHERE p.id = ?1 AND pa.pharmacy_id = ?2",
    prescriptionId, "処方が見つかりません");
}

export function assertReception(db, user, receptionId) {
  return assertOwned(db, user,
    "SELECT r.id FROM receptions r JOIN patients pa ON pa.id = r.patient_id WHERE r.id = ?1 AND pa.pharmacy_id = ?2",
    receptionId, "受付が見つかりません");
}

export function assertSchedule(db, user, scheduleId) {
  return assertOwned(db, user,
    "SELECT s.id FROM visit_schedules s JOIN patients pa ON pa.id = s.patient_id WHERE s.id = ?1 AND pa.pharmacy_id = ?2",
    scheduleId, "訪問の予定が見つかりません");
}

export function assertTracing(db, user, tracingId) {
  return assertOwned(db, user,
    "SELECT t.id FROM tracing_reports t JOIN patients pa ON pa.id = t.patient_id WHERE t.id = ?1 AND pa.pharmacy_id = ?2",
    tracingId, "トレーシングレポートが見つかりません");
}

// 本文に患者 ID が入っている API 用。整数でなければ、後の入力チェックが 422 で項目ごとに返すので、ここでは見ない
export async function assertBodyPatient(db, user, body) {
  if (Number.isInteger(body.patientId)) await assertPatient(db, user, body.patientId);
}
