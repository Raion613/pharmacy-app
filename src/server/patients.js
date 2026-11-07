import { HttpError, isDate, todayJst, nowIso } from "./http.js";
import { normalizeKana, isKatakana, searchKey } from "../../public/assets/js/text.js";
import { BURDENS, allowedBurdens, ageParts, burdenText } from "../../public/assets/js/burden.js";
import { auditStatement } from "./audit.js";

// その日の年齢でありえない割合なら、理由の文を返す
export function burdenError(birthDate, date, burdenPercent) {
  if (allowedBurdens(birthDate, date).includes(burdenPercent)) return null;
  const age = ageParts(birthDate, date);
  return `${date}時点で${age.years}歳${age.months}か月の人は、${burdenText(burdenPercent)}になりません（ありうるのは ${allowedBurdens(birthDate, date).map(burdenText).join("・")}）`;
}

// 負担割合を変える・確かめる（保険証が変わった・年齢で変わった・生活保護になった）。date はその割合を確かめた日（調剤日か今日）
export async function updateBurden(db, user, patientId, body, today = todayJst()) {
  const p = await getPatient(db, patientId);
  const date = body.date ?? today;
  if (!isDate(date) || date > today) throw new HttpError(422, "入力に誤りがあります", [{ path: "date", message: "日付が正しくありません" }]);
  if (!BURDENS.includes(body.burdenPercent)) throw new HttpError(422, "入力に誤りがあります", [{ path: "burdenPercent", message: "負担割合を選んでください" }]);
  const message = burdenError(p.birthDate, date, body.burdenPercent);
  if (message) throw new HttpError(422, "入力に誤りがあります", [{ path: "burdenPercent", message }]);
  // 同じ割合でも「この日に確かめた」ことは残す（次に割合が変わりうる日が来るまで、確認の窓を出さない）
  const checkedOn = p.burdenCheckedOn !== null && p.burdenCheckedOn > date ? p.burdenCheckedOn : date;
  await db.batch([
    db.prepare("UPDATE patients SET burden_percent = ?1, burden_checked_on = ?2 WHERE id = ?3").bind(body.burdenPercent, checkedOn, patientId),
    auditStatement(db, user.id, "patient.burden", patientId,
      p.burdenPercent === body.burdenPercent ? `${burdenText(p.burdenPercent)}のまま確認（${date}）` : `${burdenText(p.burdenPercent)} → ${burdenText(body.burdenPercent)}（${date}）`),
  ]);
  return getPatient(db, patientId);
}

export function validatePatient(body, today = todayJst()) {
  const errors = [];
  const name = String(body.name ?? "").trim().replace(/\s+/g, "　");
  const kana = normalizeKana(body.kana ?? "");
  if (name === "") errors.push({ path: "name", message: "氏名を入力してください" });
  else if (name.length > 40) errors.push({ path: "name", message: "氏名は40文字までです" });
  if (kana === "") errors.push({ path: "kana", message: "カナを入力してください" });
  else if (!isKatakana(kana)) errors.push({ path: "kana", message: "カナはカタカナで入力してください" });
  if (!isDate(body.birthDate)) errors.push({ path: "birthDate", message: "生年月日を正しい日付で入力してください" });
  else if (body.birthDate > today) errors.push({ path: "birthDate", message: "生年月日に未来の日付は入力できません" });
  else if (body.birthDate < "1900-01-01") errors.push({ path: "birthDate", message: "生年月日を確認してください" });
  if (body.sex !== "M" && body.sex !== "F") errors.push({ path: "sex", message: "性別を選んでください" });
  // 負担割合は保険証（資格確認）に書かれた割合。年齢でありうる割合が決まる（70歳以上は所得でその中のどれか）
  if (!BURDENS.includes(body.burdenPercent)) errors.push({ path: "burdenPercent", message: "負担割合を選んでください" });
  else if (errors.every((e) => e.path !== "birthDate")) {
    const message = burdenError(body.birthDate, today, body.burdenPercent);
    if (message) errors.push({ path: "burdenPercent", message });
  }
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return { name, kana, birthDate: body.birthDate, sex: body.sex, burdenPercent: body.burdenPercent };
}

export async function createPatient(db, user, body) {
  const p = validatePatient(body);
  // 患者番号は「その薬局の今の最大＋1」を6桁で。INSERT 文の中で求めるので、2人が同時に登録しても同じ番号にならない
  // （D1 は書き込みを1本ずつ処理する。万一重なっても UNIQUE 制約で失敗する）。
  // 登録とアクセスログは同じ batch（＝1トランザクション）。ログの患者IDは直前の INSERT の行IDを使う。
  const now = nowIso();
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO patients (pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by, burden_checked_on)
       VALUES (?8, (SELECT printf('%06d', COALESCE(MAX(CAST(patient_no AS INTEGER)), 0) + 1) FROM patients WHERE pharmacy_id = ?8),
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9)
       RETURNING id, patient_no`,
    ).bind(p.name, p.kana, p.birthDate, p.sex, p.burdenPercent, now, user.id, user.pharmacy_id, todayJst()), // 登録のときに保険証で割合を確かめている
    db.prepare(
      `INSERT INTO access_logs (at, user_id, action, patient_id, detail)
       VALUES (?1, ?2, 'patient.create', last_insert_rowid(), NULL)`,
    ).bind(now, user.id),
  ]);
  const row = inserted.results[0];
  return { id: row.id, patientNo: row.patient_no };
}

// 一覧・詳細で共通の列。注意の分類は、アレルギー歴・副作用歴のメモ（今の内容）がある分類（カンマ区切り）
const PATIENT_SELECT = `
  SELECT pa.id, pa.patient_no, pa.name, pa.kana, pa.birth_date, pa.sex, pa.burden_percent, pa.burden_checked_on,
         (SELECT MAX(dispensed_on) FROM prescriptions WHERE patient_id = pa.id) AS last_dispensed_on,
         (SELECT group_concat(DISTINCT n.category) FROM patient_notes n
           WHERE n.patient_id = pa.id AND n.category IN ('allergy', 'adverse')
             AND NOT EXISTS (SELECT 1 FROM patient_notes x WHERE x.revises = n.id)) AS alert_categories
    FROM patients pa`;

// 自分の薬局の患者を、患者番号（前方一致）、カナ（部分一致）、氏名（部分一致）で探す。空なら最近来局した順。
export async function searchPatients(db, pharmacyId, q) {
  const text = String(q ?? "").trim();
  let stmt;
  if (text === "") {
    stmt = db.prepare(`${PATIENT_SELECT} WHERE pa.pharmacy_id = ?1
      ORDER BY last_dispensed_on IS NULL, last_dispensed_on DESC, pa.id DESC LIMIT 50`).bind(pharmacyId);
  } else {
    stmt = db
      .prepare(
        `${PATIENT_SELECT}
          WHERE pa.pharmacy_id = ?4
            AND (pa.patient_no LIKE ?1 || '%'
             OR REPLACE(pa.kana, '　', '') LIKE '%' || ?2 || '%'
             OR REPLACE(pa.name, '　', '') LIKE '%' || ?3 || '%')
          ORDER BY pa.kana LIMIT 50`,
      )
      .bind(text.normalize("NFKC"), searchKey(text), text.replace(/\s+/g, ""), pharmacyId);
  }
  const { results } = await stmt.all();
  return results.map(toPatientJson);
}

export async function getPatient(db, id) {
  const row = await db.prepare(`${PATIENT_SELECT} WHERE pa.id = ?1`).bind(id).first();
  if (!row) throw new HttpError(404, "患者が見つかりません");
  return toPatientJson(row);
}

function toPatientJson(row) {
  return {
    id: row.id,
    patientNo: row.patient_no,
    name: row.name,
    kana: row.kana,
    birthDate: row.birth_date,
    sex: row.sex,
    burdenPercent: row.burden_percent,
    burdenCheckedOn: row.burden_checked_on,
    lastDispensedOn: row.last_dispensed_on,
    alertCategories: row.alert_categories === null ? [] : row.alert_categories.split(","),
  };
}
