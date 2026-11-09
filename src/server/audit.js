import { nowIso } from "./http.js";

// アクセスログの1行を INSERT する文を返す。保存処理と同じ batch に入れられるよう、実行はしない。
export function auditStatement(db, userId, action, patientId = null, detail = null) {
  return db
    .prepare("INSERT INTO access_logs (at, user_id, action, patient_id, detail) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(nowIso(), userId, action, patientId, detail);
}
