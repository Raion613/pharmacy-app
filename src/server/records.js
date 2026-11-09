// 患者メモ・指導記録（SOAP）・会話の文字起こし・指導記録のテンプレート。どれも追記だけで、書き込みはアクセスログと同じトランザクションに入れる。
import { HttpError, nowIso } from "./http.js";
import { NOTE_LABEL, SOAP, LEFTOVER, NOTEBOOK, NOTE_MAX, SOAP_MAX } from "../../public/assets/js/record-kinds.js";
import { auditStatement } from "./audit.js";
import { transcribe } from "./ai-stub.js";
import { extractNotes } from "../rules/soap-draft.js";

const NOTE_SOURCES = ["manual", "conversation"];
const MAX_NOTES_AT_ONCE = 10;
const MAX_RECORDING_SEC = 60 * 60;

export function validateNote(body) {
  const errors = [];
  if (!Object.hasOwn(NOTE_LABEL, body.category ?? "")) errors.push({ path: "category", message: "分類を選んでください" });
  const text = String(body.body ?? "").trim();
  if (text === "") errors.push({ path: "body", message: "内容を入力してください" });
  else if (text.length > NOTE_MAX) errors.push({ path: "body", message: `内容は${NOTE_MAX}文字までです` });
  const source = body.source ?? "manual";
  if (!NOTE_SOURCES.includes(source)) errors.push({ path: "source", message: "メモの出どころが不正です" });
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return { category: body.category, body: text, source };
}

const insertNote = (db, user, patientId, note, now, revises = null) => db.prepare(
  "INSERT INTO patient_notes (patient_id, category, body, source, created_at, created_by, revises) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id",
).bind(patientId, note.category, note.body, note.source, now, user.id, revises);

async function requirePatient(db, patientId) {
  const patient = await db.prepare("SELECT id FROM patients WHERE id = ?1").bind(patientId).first();
  if (!patient) throw new HttpError(404, "患者が見つかりません");
}

// メモを1件ずつ（アレルギー1つ、併用薬1つ）まとめて入れる。手で書いたものも、会話から拾って薬剤師が選んだものも。
// 全部入るか、1つも入らないか
export async function createNotes(db, user, patientId, body) {
  if (!Array.isArray(body.notes) || body.notes.length === 0 || body.notes.length > MAX_NOTES_AT_ONCE) {
    throw new HttpError(422, "入力に誤りがあります", [{ path: "notes", message: `メモを1〜${MAX_NOTES_AT_ONCE}件選んでください` }]);
  }
  const notes = body.notes.map((n) => validateNote(n));
  await requirePatient(db, patientId);
  const now = nowIso();
  const results = await db.batch([
    ...notes.map((n) => insertNote(db, user, patientId, n, now)),
    auditStatement(db, user.id, "note.create", patientId, notes.map((n) => NOTE_LABEL[n.category]).join("・")),
  ]);
  return notes.map((n, i) => ({ id: results[i].results[0].id, ...n, createdAt: now, createdBy: user.display_name, history: [] }));
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
  const conversationId = body.conversationId ?? null;
  if (conversationId !== null && !Number.isInteger(conversationId)) errors.push({ path: "conversationId", message: "会話の指定が不正です" });
  if (typeof (body.drafted ?? false) !== "boolean") errors.push({ path: "drafted", message: "下書きの印が不正です" });
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return { ...record, leftover: body.leftover, notebook: body.notebook, conversationId, drafted: body.drafted ?? false };
}

// 指導記録は来局（処方）にひも付ける。患者は処方から引くので、画面から患者IDは受け取らない
export async function createRecord(db, user, prescriptionId, body) {
  const r = validateRecord(body);
  const rx = await db.prepare("SELECT id, patient_id, dispensed_on FROM prescriptions WHERE id = ?1").bind(prescriptionId).first();
  if (!rx) throw new HttpError(404, "処方が見つかりません");
  if (r.conversationId !== null) {
    const c = await db.prepare("SELECT prescription_id FROM conversations WHERE id = ?1").bind(r.conversationId).first();
    if (!c || c.prescription_id !== rx.id) throw new HttpError(422, "入力に誤りがあります", [{ path: "conversationId", message: "この来局の会話ではありません" }]);
  }
  const now = nowIso();
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO guidance_records
         (prescription_id, patient_id, subjective, objective, assessment, plan, leftover, notebook, conversation_id, drafted, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING id`,
    ).bind(rx.id, rx.patient_id, r.subjective, r.objective, r.assessment, r.plan, r.leftover, r.notebook,
      r.conversationId, r.drafted ? 1 : 0, now, user.id),
    auditStatement(db, user.id, "record.create", rx.patient_id, `調剤日 ${rx.dispensed_on} の指導記録${r.drafted ? "（下書きから）" : ""}`),
  ]);
  return {
    id: inserted.results[0].id, prescriptionId: rx.id, patientId: rx.patient_id, ...r, createdAt: now, createdBy: user.display_name,
  };
}

// 服薬指導の会話を文字にして保存する。body：{ source: recording|file, fileName, durationSec }
export async function createConversation(db, user, prescriptionId, body) {
  const errors = [];
  if (body.source !== "recording" && body.source !== "file") errors.push({ path: "source", message: "録音の方法が不正です" });
  const fileName = body.source === "file" ? String(body.fileName ?? "").trim() : null;
  if (body.source === "file" && (fileName === "" || fileName.length > 200)) errors.push({ path: "fileName", message: "録音のファイルを選んでください" });
  if (!Number.isInteger(body.durationSec) || body.durationSec < 1 || body.durationSec > MAX_RECORDING_SEC) {
    errors.push({ path: "durationSec", message: "録音の長さが不正です（1秒〜60分）" });
  }
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);

  const rx = await db.prepare("SELECT id, patient_id, dispensed_on FROM prescriptions WHERE id = ?1").bind(prescriptionId).first();
  if (!rx) throw new HttpError(404, "処方が見つかりません");
  const { results: drugs } = await db.prepare(
    `SELECT d.name FROM prescription_items i JOIN prescription_rps r ON r.id = i.rp_id JOIN drugs d ON d.code = i.drug_code
      WHERE r.prescription_id = ?1 ORDER BY r.rp_no, i.line_no`,
  ).bind(rx.id).all();
  const transcript = transcribe({ drugNames: drugs.map((d) => d.name) });
  const now = nowIso();
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO conversations (prescription_id, patient_id, source, file_name, duration_sec, transcript, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
    ).bind(rx.id, rx.patient_id, body.source, fileName, body.durationSec, transcript, now, user.id),
    auditStatement(db, user.id, "conversation.create", rx.patient_id, `調剤日 ${rx.dispensed_on} の服薬指導（${body.durationSec}秒）`),
  ]);
  return {
    id: inserted.results[0].id, prescriptionId: rx.id, source: body.source, fileName, durationSec: body.durationSec, transcript, extracted: extractNotes(transcript),
    createdAt: now, createdBy: user.display_name,
  };
}

// メモを直す。直した内容を新しい行として足し、直す前の行は残す。直せるのは今の内容（まだ誰も直していない行）だけ
export async function updateNote(db, user, patientId, noteId, body) {
  const old = await db.prepare(
    `SELECT n.id, n.source, EXISTS (SELECT 1 FROM patient_notes x WHERE x.revises = n.id) AS revised
       FROM patient_notes n WHERE n.id = ?1 AND n.patient_id = ?2`,
  ).bind(noteId, patientId).first();
  if (!old) throw new HttpError(404, "メモが見つかりません");
  if (old.revised) throw new HttpError(422, "入力に誤りがあります", [{ path: "body", message: "ほかの人が先にこのメモを直しました。画面を読み直してください" }]);
  const note = validateNote({ ...body, source: old.source });
  const now = nowIso();
  const [inserted] = await db.batch([
    insertNote(db, user, patientId, note, now, noteId),
    auditStatement(db, user.id, "note.update", patientId, NOTE_LABEL[note.category]),
  ]);
  return (await notesOf(db, patientId)).find((n) => n.id === inserted.results[0].id);
}

// 今の内容のメモを新しい順に（まとめて登録したものは書いた順）。直したメモは history に直す前の内容（新しい順）を持つ
export async function notesOf(db, patientId) {
  const { results } = await db.prepare(
    `SELECT n.id, n.category, n.body, n.source, n.created_at, n.revises, u.display_name AS created_by
       FROM patient_notes n JOIN users u ON u.id = n.created_by
      WHERE n.patient_id = ?1 ORDER BY n.created_at DESC, n.id -- 同時に登録した行は、書いた順
`,
  ).bind(patientId).all();
  const byId = new Map(results.map((n) => [n.id, n]));
  const revised = new Set(results.map((n) => n.revises).filter((id) => id !== null));
  const json = (n) => ({ id: n.id, category: n.category, body: n.body, source: n.source, createdAt: n.created_at, createdBy: n.created_by });
  return results.filter((n) => !revised.has(n.id)).map((n) => {
    const history = [];
    for (let p = n.revises; p !== null; p = byId.get(p).revises) history.push(json(byId.get(p)));
    return { ...json(n), history };
  });
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
    conversationId: g.conversation_id,
    drafted: g.drafted === 1,
    createdAt: g.created_at,
    createdBy: g.author,
  })), (g) => g.prescriptionId);
}

// 患者の会話の文字起こしを、処方ID → 配列（新しい順）にして返す
export async function conversationsByPrescription(db, patientId) {
  const { results } = await db.prepare(
    `SELECT c.*, u.display_name AS author FROM conversations c JOIN users u ON u.id = c.created_by
      WHERE c.patient_id = ?1 ORDER BY c.created_at DESC, c.id DESC`,
  ).bind(patientId).all();
  return Map.groupBy(results.map((c) => ({
    id: c.id, prescriptionId: c.prescription_id, source: c.source, fileName: c.file_name, durationSec: c.duration_sec,
    transcript: c.transcript, extracted: extractNotes(c.transcript), createdAt: c.created_at, createdBy: c.author,
  })), (c) => c.prescriptionId);
}

// ---------- テンプレート ----------

export async function templatesOf(db, pharmacyId) {
  const { results } = await db.prepare(
    "SELECT id, title, subjective, objective, assessment, plan FROM guidance_templates WHERE pharmacy_id = ?1 ORDER BY title",
  ).bind(pharmacyId).all();
  return results;
}

export async function createTemplate(db, user, body) {
  const title = String(body.title ?? "").trim();
  const errors = [];
  if (title === "") errors.push({ path: "title", message: "テンプレートの名前を入力してください" });
  else if (title.length > 40) errors.push({ path: "title", message: "名前は40文字までです" });
  const t = {};
  for (const { key, letter } of SOAP) {
    t[key] = String(body[key] ?? "").trim();
    if (t[key].length > SOAP_MAX) errors.push({ path: key, message: `${letter}は${SOAP_MAX}文字までです` });
  }
  if (SOAP.every(({ key }) => t[key] === "")) errors.push({ path: "subjective", message: "S・O・A・P のどれかを入力してください" });
  if (errors.length === 0 && await db.prepare("SELECT 1 FROM guidance_templates WHERE pharmacy_id = ?1 AND title = ?2").bind(user.pharmacy_id, title).first()) {
    errors.push({ path: "title", message: "同じ名前のテンプレートがあります" });
  }
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  const row = await db.prepare(
    `INSERT INTO guidance_templates (pharmacy_id, title, subjective, objective, assessment, plan, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
  ).bind(user.pharmacy_id, title, t.subjective, t.objective, t.assessment, t.plan, nowIso(), user.id).first();
  return { id: row.id, title, ...t };
}
