// メモ帳：患者ごとの自由なメモ。家族構成・懸念事項・スタッフ間の伝言など、決まった分類に入らないことを薬局が好きに書く。
// 書き換えるたびに新しい行を足し、いちばん新しい行を今の内容とする（前の内容は消さない。誰がいつ書き換えたかも残る）
import { HttpError, nowIso } from "./http.js";
import { auditStatement } from "./audit.js";

export const MEMO_MAX = 2000;

export async function memoOf(db, patientId) {
  const row = await db.prepare(
    `SELECT m.body, m.created_at, u.display_name AS author FROM patient_memos m JOIN users u ON u.id = m.created_by
      WHERE m.patient_id = ?1 ORDER BY m.id DESC LIMIT 1`,
  ).bind(patientId).first();
  return row ? { body: row.body, updatedAt: row.created_at, updatedBy: row.author } : { body: "", updatedAt: null, updatedBy: null };
}

// 今の内容と同じなら何も足さない
export async function saveMemo(db, user, patientId, body) {
  const text = String(body.body ?? "").replace(/\r\n/g, "\n").trimEnd();
  if (text.length > MEMO_MAX) throw new HttpError(422, "入力に誤りがあります", [{ path: "body", message: `メモ帳は${MEMO_MAX}文字までです` }]);
  if ((await memoOf(db, patientId)).body === text) return memoOf(db, patientId);
  await db.batch([
    db.prepare("INSERT INTO patient_memos (patient_id, body, created_at, created_by) VALUES (?1, ?2, ?3, ?4)").bind(patientId, text, nowIso(), user.id),
    auditStatement(db, user.id, "memo.update", patientId, null),
  ]);
  return memoOf(db, patientId);
}
