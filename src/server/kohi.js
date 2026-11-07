// 公費（受給者証）の登録と、処方に使う公費の検証。計算の規則は public/assets/js/kohi.js
import { HttpError, isDate, nowIso } from "./http.js";
import { auditStatement } from "./audit.js";
import { KOHI_KINDS, LOCAL_FORMS, isNational, kohiName, kohiValidOn, hasMonthlyCap } from "../../public/assets/js/kohi.js";

const MAX_YEN = 1_000_000;
const yenOrNull = (v) => (v === null || v === undefined || v === "" ? null : v);

function toJson(r) {
  return {
    id: r.id, kind: r.kind, payerNo: r.payer_no, recipientNo: r.recipient_no, localName: r.local_name, localForm: r.local_form,
    perVisitYen: r.per_visit_yen, capYen: r.cap_yen, validFrom: r.valid_from, validUntil: r.valid_until,
  };
}

export async function kohiOf(db, patientId) {
  const { results } = await db.prepare("SELECT * FROM patient_kohi WHERE patient_id = ?1 ORDER BY valid_until DESC, id DESC").bind(patientId).all();
  return results.map(toJson);
}

export function validateKohi(body) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  const kind = body.kind;
  if (!Object.hasOwn(KOHI_KINDS, kind ?? "")) err("kind", "公費の種類を選んでください");
  const payerNo = String(body.payerNo ?? "").trim();
  const recipientNo = String(body.recipientNo ?? "").trim();
  if (!/^\d{8}$/.test(payerNo)) err("payerNo", "公費負担者番号は8桁の数字です");
  else if (kind && isNational(kind) && !payerNo.startsWith(KOHI_KINDS[kind].law)) {
    err("payerNo", `${KOHI_KINDS[kind].label}の公費負担者番号は ${KOHI_KINDS[kind].law} で始まります`);
  }
  if (!/^\d{1,16}$/.test(recipientNo)) err("recipientNo", "受給者番号を数字で入力してください");
  else if (kind && isNational(kind) && !/^\d{7}$/.test(recipientNo)) err("recipientNo", "受給者番号は7桁の数字です");
  if (!isDate(body.validFrom)) err("validFrom", "有効期間の始まりを入力してください");
  if (!isDate(body.validUntil)) err("validUntil", "有効期間の終わりを入力してください");
  if (isDate(body.validFrom) && isDate(body.validUntil) && body.validFrom > body.validUntil) err("validUntil", "有効期間の終わりが始まりより前です");

  const cap = yenOrNull(body.capYen);
  const perVisit = yenOrNull(body.perVisitYen);
  const yenOk = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_YEN;
  let localName = null;
  let localForm = null;
  if (kind === "local") {
    localName = String(body.localName ?? "").trim();
    if (localName === "") err("localName", "助成の名前を入力してください（例：子ども医療費助成（上田市））");
    else if (localName.length > 40) err("localName", "助成の名前は40文字までです");
    localForm = body.localForm;
    if (!Object.hasOwn(LOCAL_FORMS, localForm ?? "")) err("localForm", "薬局での負担の形を選んでください");
    if (localForm === "perVisit" && !yenOk(perVisit)) err("perVisitYen", "1回の額を円で入力してください");
    if (localForm === "cap" && !yenOk(cap)) err("capYen", "月の上限額を円で入力してください");
  } else if (cap !== null && !yenOk(cap)) {
    err("capYen", "上限月額を円で入力してください（上限なしなら空）");
  }
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return {
    kind, payerNo, recipientNo, localName, localForm,
    perVisitYen: localForm === "perVisit" ? perVisit : null,
    capYen: kind === "local" ? (localForm === "cap" ? cap : null) : cap,
    validFrom: body.validFrom, validUntil: body.validUntil,
  };
}

export async function createKohi(db, user, patientId, body) {
  const k = validateKohi(body);
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO patient_kohi (patient_id, kind, payer_no, recipient_no, local_name, local_form, per_visit_yen, cap_yen, valid_from, valid_until, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING id`,
    ).bind(patientId, k.kind, k.payerNo, k.recipientNo, k.localName, k.localForm, k.perVisitYen, k.capYen, k.validFrom, k.validUntil, nowIso(), user.id),
    auditStatement(db, user.id, "kohi.create", patientId, `${kohiName(k)}（${k.validFrom}〜${k.validUntil}）`),
  ]);
  return { id: inserted.results[0].id, ...k };
}

// 処方に使う公費を検証し、計算に使う形にする。body.kohi：[{ kohiId, priorMonthYen }]
//   priorMonthYen：自己負担上限額管理票に書かれた、この来局より前の今月の累計（月の上限のある公費だけ）
export async function kohiForPrescription(db, patientId, dispensedOn, list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 4) throw new HttpError(422, "入力に誤りがあります", [{ path: "kohi", message: "公費の指定が不正です" }]);
  const own = new Map((await kohiOf(db, patientId)).map((k) => [k.id, k]));
  const errors = [];
  const seen = new Set();
  const out = list.map((x, i) => {
    const k = own.get(x.kohiId);
    if (!k || seen.has(x.kohiId)) {
      errors.push({ path: `kohi.${i}`, message: "この患者の公費ではありません" });
      return null;
    }
    seen.add(x.kohiId);
    if (!kohiValidOn(k, dispensedOn)) errors.push({ path: `kohi.${i}`, message: `${kohiName(k)}は調剤日に有効期間外です（${k.validFrom}〜${k.validUntil}）` });
    let prior = null;
    if (hasMonthlyCap(k)) {
      prior = x.priorMonthYen;
      if (!Number.isInteger(prior) || prior < 0 || prior > MAX_YEN) errors.push({ path: `kohi.${i}.priorMonthYen`, message: `${kohiName(k)}：管理票の今月の累計を円で入力してください（無ければ 0）` });
    }
    return { ...k, priorMonthYen: prior };
  });
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return out;
}

// この薬局でその月に、公費ごとに患者が払った額（管理票の累計の初期値に使う。他の医療機関の分は入らない）
export async function kohiMonthPaid(db, patientId, date, excludePrescriptionId = null) {
  const { results } = await db.prepare(
    `SELECT k.kohi_id, SUM(k.pay_yen) AS paid FROM prescription_kohi k JOIN prescriptions p ON p.id = k.prescription_id
      WHERE p.patient_id = ?1 AND strftime('%Y-%m', p.dispensed_on) = strftime('%Y-%m', ?2) AND p.dispensed_on <= ?2 AND p.id IS NOT ?3
      GROUP BY k.kohi_id`,
  ).bind(patientId, date, excludePrescriptionId).all();
  return Object.fromEntries(results.map((r) => [r.kohi_id, r.paid]));
}
