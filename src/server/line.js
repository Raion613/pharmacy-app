// 「つながる薬局」（ファーマシフト社の LINE 公式アカウントのサービス）でのやり取り。
// 実際のサービスとはつないでいない。本物なら、つながる薬局から届くメッセージ（Webhook という、相手のサーバーが
// こちらの URL に送ってくる HTTP リクエスト）を receiveMessage で受け、薬局からの返信は相手の API に送る。
// ここでは画面の「受信したことにする」から receiveMessage を呼び、返信は保存だけする。
import { HttpError, nowIso } from "./http.js";
import { auditStatement } from "./audit.js";

const BODY_MAX = 500;

function validate(body) {
  const errors = [];
  if (!Number.isInteger(body.patientId)) errors.push({ path: "patientId", message: "患者を選んでください" });
  const text = String(body.body ?? "").trim();
  if (text === "") errors.push({ path: "body", message: "メッセージを入力してください" });
  else if (text.length > BODY_MAX) errors.push({ path: "body", message: `メッセージは${BODY_MAX}文字までです` });
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return text;
}

async function requirePatient(db, id) {
  if (!await db.prepare("SELECT 1 FROM patients WHERE id = ?1").bind(id).first()) throw new HttpError(404, "患者が見つかりません");
}

// 患者からのメッセージを受け取る（sentAt は相手のサービスが付けた送信時刻。無ければ受け取った時刻）
export async function receiveMessage(db, user, body) {
  const text = validate(body);
  await requirePatient(db, body.patientId);
  const sentAt = body.sentAt ?? nowIso();
  if (typeof sentAt !== "string" || Number.isNaN(Date.parse(sentAt))) throw new HttpError(422, "送信時刻が不正です");
  const [inserted] = await db.batch([
    db.prepare("INSERT INTO line_messages (patient_id, direction, body, sent_at, created_by) VALUES (?1, 'in', ?2, ?3, NULL) RETURNING id")
      .bind(body.patientId, text, new Date(sentAt).toISOString()),
    auditStatement(db, user.id, "line.receive", body.patientId, "つながる薬局のメッセージを受信（デモ）"),
  ]);
  return { id: inserted.results[0].id };
}

export async function replyMessage(db, user, body) {
  const text = validate(body);
  await requirePatient(db, body.patientId);
  const [inserted] = await db.batch([
    db.prepare("INSERT INTO line_messages (patient_id, direction, body, sent_at, created_by) VALUES (?1, 'out', ?2, ?3, ?4) RETURNING id")
      .bind(body.patientId, text, nowIso(), user.id),
    auditStatement(db, user.id, "line.reply", body.patientId, "つながる薬局で返信"),
  ]);
  return { id: inserted.results[0].id };
}

const SELECT = `
  SELECT m.id, m.patient_id, m.direction, m.body, m.sent_at, u.display_name AS by, pa.name, pa.patient_no
    FROM line_messages m JOIN patients pa ON pa.id = m.patient_id LEFT JOIN users u ON u.id = m.created_by`;

const toJson = (m) => ({
  id: m.id, patientId: m.patient_id, direction: m.direction, body: m.body, sentAt: m.sent_at, by: m.by,
  patient: { name: m.name, patientNo: m.patient_no },
});

export async function messagesOf(db, patientId) {
  const { results } = await db.prepare(`${SELECT} WHERE m.patient_id = ?1 ORDER BY m.sent_at, m.id`).bind(patientId).all();
  return results.map(toJson);
}

// 患者ごとの最新のメッセージ（新しい順）。受信箱の一覧
export async function threads(db) {
  const { results } = await db.prepare(
    `${SELECT} WHERE m.id = (SELECT x.id FROM line_messages x WHERE x.patient_id = m.patient_id ORDER BY x.sent_at DESC, x.id DESC LIMIT 1)
      ORDER BY m.sent_at DESC`,
  ).all();
  return results.map(toJson);
}
