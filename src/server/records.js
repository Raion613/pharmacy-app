// 患者メモと指導記録（SOAP）。どちらも追記だけで、書き込みはアクセスログと同じトランザクションに入れる。
import { HttpError, nowIso } from "./http.js";
import { NOTE_LABEL, SOAP, LEFTOVER, NOTEBOOK, NOTE_MAX, SOAP_MAX } from "../../public/assets/js/record-kinds.js";
import { auditStatement } from "./audit.js";

export function validateNote(body) {
  const errors = [];
  if (!Object.hasOwn(NOTE_LABEL, body.category ?? "")) errors.push({ path: "category", message: "分類を選んでください" });
  const text = String(body.body ?? "").trim();
  if (text === "") errors.push({ path: "body", message: "内容を入力してください" });
  else if (text.length > NOTE_MAX) errors.push({ path: "body", message: `内容は${NOTE_MAX}文字までです` });
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return { category: body.category, body: text };
}

export async function createNote(db, user, patientId, body) {
  const note = validateNote(body);
  const patient = await db.prepare("SELECT id FROM patients WHERE id = ?1").bind(patientId).first();
  if (!patient) throw new HttpError(404, "患者が見つかりません");
  const now = nowIso();
  const [inserted] = await db.batch([
    db.prepare(
      "INSERT INTO patient_notes (patient_id, category, body, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
    ).bind(patientId, note.category, note.body, now, user.id),
    auditStatement(db, user.id, "note.create", patientId, NOTE_LABEL[note.category]),
  ]);
  return { id: inserted.results[0].id, category: note.category, body: note.body, createdAt: now, createdBy: user.display_name };
}

export function validateRecord(body) {
  const errors = [];
  const record = {};
  for (const { key, letter } of SOAP) {
    const text = String(body[key] ?? "").trim();
    if (text.length > SOAP_MAX) errors.push({ path: key, message: `${letter}は${SOAP_MAX}文字までです` });
    record[key] = text;
  }
  if (SOAP.every(({ key }) => record[key] === "")) errors.push({ path: "subjective", message: "S・O・A・P のどれかを入力してください" });
  if (!Object.hasOwn(LEFTOVER, body.leftover ?? "")) errors.push({ path: "leftover", message: "残薬の確認結果を選んでください" });
  if (!Object.hasOwn(NOTEBOOK, body.notebook ?? "")) errors.push({ path: "notebook", message: "お薬手帳の確認結果を選んでください" });
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return { ...record, leftover: body.leftover, notebook: body.notebook };
}

// 指導記録は来局（処方）にひも付ける。患者は処方から引くので、画面から患者IDは受け取らない
export async function createRecord(db, user, prescriptionId, body) {
  const r = validateRecord(body);
  const rx = await db.prepare("SELECT id, patient_id, dispensed_on FROM prescriptions WHERE id = ?1").bind(prescriptionId).first();
  if (!rx) throw new HttpError(404, "処方が見つかりません");
  const now = nowIso();
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO guidance_records
         (prescription_id, patient_id, subjective, objective, assessment, plan, leftover, notebook, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`,
    ).bind(rx.id, rx.patient_id, r.subjective, r.objective, r.assessment, r.plan, r.leftover, r.notebook, now, user.id),
    auditStatement(db, user.id, "record.create", rx.patient_id, `調剤日 ${rx.dispensed_on} の指導記録`),
  ]);
  return {
    id: inserted.results[0].id, prescriptionId: rx.id, patientId: rx.patient_id, ...r, createdAt: now, createdBy: user.display_name,
  };
}

export async function notesOf(db, patientId) {
  const { results } = await db.prepare(
    `SELECT n.id, n.category, n.body, n.created_at, u.display_name AS created_by
       FROM patient_notes n JOIN users u ON u.id = n.created_by
      WHERE n.patient_id = ?1 ORDER BY n.created_at DESC, n.id DESC`,
  ).bind(patientId).all();
  return results.map((n) => ({ id: n.id, category: n.category, body: n.body, createdAt: n.created_at, createdBy: n.created_by }));
}

// 患者の指導記録を、処方ID → 記録の配列（新しい順）にして返す
export async function recordsByPrescription(db, patientId) {
  const { results } = await db.prepare(
    `SELECT g.*, u.display_name AS author
       FROM guidance_records g JOIN users u ON u.id = g.created_by
      WHERE g.patient_id = ?1 ORDER BY g.created_at DESC, g.id DESC`,
  ).bind(patientId).all();
  return Map.groupBy(results.map((g) => ({
    id: g.id,
    prescriptionId: g.prescription_id,
    subjective: g.subjective,
    objective: g.objective,
    assessment: g.assessment,
    plan: g.plan,
    leftover: g.leftover,
    notebook: g.notebook,
    createdAt: g.created_at,
    createdBy: g.author,
  })), (g) => g.prescriptionId);
}
