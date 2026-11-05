// 在宅訪問：施設・在宅の患者・薬学的管理指導計画書・訪問の予定と記録・処方医への報告書。どれも追記だけ。
// 訪問の点数（在宅患者訪問薬剤管理指導料）の算定はしない。回数の上限だけを予定を入れるときに確かめる。
import { HttpError, isDate, nowIso } from "./http.js";
import { auditStatement } from "./audit.js";
import { checkVisit, planReviewDue } from "../../public/assets/js/home-visit-rules.js";

function texts(body, specs, errors) {
  const out = {};
  for (const [key, label, max, required] of specs) {
    out[key] = String(body[key] ?? "").trim();
    if (required && out[key] === "") errors.push({ path: key, message: `${label}を入力してください` });
    else if (out[key].length > max) errors.push({ path: key, message: `${label}は${max}文字までです` });
  }
  return out;
}

const fail = (errors) => {
  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
};

// ---------- 施設 ----------

export async function createFacility(db, user, body) {
  const errors = [];
  const f = texts(body, [["name", "施設名", 60, true], ["address", "住所", 100, true], ["phone", "電話番号", 20, true]], errors);
  if (errors.length === 0 && await db.prepare("SELECT 1 FROM facilities WHERE name = ?1").bind(f.name).first()) {
    errors.push({ path: "name", message: "同じ名前の施設があります" });
  }
  fail(errors);
  const row = await db.prepare(
    "INSERT INTO facilities (name, address, phone, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
  ).bind(f.name, f.address, f.phone, nowIso(), user.id).first();
  return { id: row.id, ...f };
}

// ---------- 在宅の患者 ----------

export async function registerHomePatient(db, user, body) {
  const errors = [];
  if (!Number.isInteger(body.patientId)) errors.push({ path: "patientId", message: "患者を選んでください" });
  const facilityId = body.facilityId ?? null;
  if (facilityId !== null && !Number.isInteger(facilityId)) errors.push({ path: "facilityId", message: "施設の指定が不正です" });
  const h = texts(body, [["institution", "医療機関", 60, true], ["doctor", "指示した医師", 30, true], ["careManager", "ケアマネジャー", 40, false]], errors);
  if (typeof body.intensive !== "boolean") errors.push({ path: "intensive", message: "回数の区分を選んでください" });
  if (!isDate(body.startedOn)) errors.push({ path: "startedOn", message: "訪問を始めた日を正しい日付で入力してください" });
  fail(errors);
  const patient = await db.prepare("SELECT id, (SELECT 1 FROM home_patients WHERE patient_id = ?1) AS registered FROM patients WHERE id = ?1")
    .bind(body.patientId).first();
  if (!patient) throw new HttpError(404, "患者が見つかりません");
  if (patient.registered) fail([{ path: "patientId", message: "この患者はもう在宅の患者として登録されています" }]);
  if (facilityId !== null && !await db.prepare("SELECT 1 FROM facilities WHERE id = ?1").bind(facilityId).first()) {
    fail([{ path: "facilityId", message: "施設が見つかりません" }]);
  }
  await db.batch([
    db.prepare(
      `INSERT INTO home_patients (patient_id, facility_id, institution, doctor, care_manager, intensive, started_on, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(body.patientId, facilityId, h.institution, h.doctor, h.careManager || null, body.intensive ? 1 : 0, body.startedOn, nowIso(), user.id),
    auditStatement(db, user.id, "homecare.register", body.patientId, `${h.institution} ${h.doctor} 医師の指示`),
  ]);
  return { patientId: body.patientId };
}

// ---------- 計画書 ----------

export async function createPlan(db, user, patientId, body) {
  const errors = [];
  if (!isDate(body.madeOn)) errors.push({ path: "madeOn", message: "作成日を正しい日付で入力してください" });
  const p = texts(body, [
    ["management", "薬剤の管理方法", 400, true], ["drugNotes", "薬剤特性（副作用・相互作用等）", 400, true],
    ["guidance", "実施すべき指導の内容", 400, true], ["intervalText", "訪問間隔", 40, true],
  ], errors);
  if (!Number.isInteger(body.visitsPerMonth) || body.visitsPerMonth < 1 || body.visitsPerMonth > 8) {
    errors.push({ path: "visitsPerMonth", message: "訪問回数は月1〜8回で入力してください" });
  }
  fail(errors);
  const home = await homePatient(db, patientId);
  if (!home.intensive && body.visitsPerMonth > 4) fail([{ path: "visitsPerMonth", message: "この患者は月4回までです" }]);
  await db.batch([
    db.prepare(
      `INSERT INTO care_plans (patient_id, made_on, management, drug_notes, guidance, visits_per_month, interval_text, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(patientId, body.madeOn, p.management, p.drugNotes, p.guidance, body.visitsPerMonth, p.intervalText, nowIso(), user.id),
    auditStatement(db, user.id, "homecare.plan", patientId, `${body.madeOn} の計画書`),
  ]);
  return homeDetail(db, patientId);
}

async function homePatient(db, patientId) {
  const h = await db.prepare("SELECT * FROM home_patients WHERE patient_id = ?1").bind(patientId).first();
  if (!h) throw new HttpError(404, "在宅の患者として登録されていません");
  return h;
}

// ---------- 訪問の予定 ----------

export async function createSchedule(db, user, body) {
  const errors = [];
  if (!Number.isInteger(body.patientId)) errors.push({ path: "patientId", message: "患者を選んでください" });
  if (!isDate(body.visitOn)) errors.push({ path: "visitOn", message: "訪問日を正しい日付で入力してください" });
  if (!Number.isInteger(body.pharmacistId)) errors.push({ path: "pharmacistId", message: "担当の薬剤師を選んでください" });
  fail(errors);
  const home = await homePatient(db, body.patientId);
  if (body.visitOn < home.started_on) fail([{ path: "visitOn", message: "訪問を始めた日より前です" }]);
  if (!await db.prepare("SELECT 1 FROM users WHERE id = ?1").bind(body.pharmacistId).first()) fail([{ path: "pharmacistId", message: "薬剤師が見つかりません" }]);
  const [mine, theirs] = await db.batch([
    db.prepare("SELECT visit_on FROM visit_schedules WHERE patient_id = ?1").bind(body.patientId),
    db.prepare("SELECT visit_on FROM visit_schedules WHERE pharmacist_id = ?1").bind(body.pharmacistId),
  ]);
  const reasons = checkVisit({
    date: body.visitOn, intensive: home.intensive === 1,
    patientDates: mine.results.map((r) => r.visit_on), pharmacistDates: theirs.results.map((r) => r.visit_on),
  });
  fail(reasons.map((message) => ({ path: "visitOn", message })));
  const [inserted] = await db.batch([
    db.prepare("INSERT INTO visit_schedules (patient_id, visit_on, pharmacist_id, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id")
      .bind(body.patientId, body.visitOn, body.pharmacistId, nowIso(), user.id),
    auditStatement(db, user.id, "homecare.schedule", body.patientId, `${body.visitOn} の訪問予定`),
  ]);
  return { id: inserted.results[0].id };
}

// ---------- 訪問の記録 ----------

export async function createVisitRecord(db, user, scheduleId, body) {
  const errors = [];
  const v = texts(body, [
    ["storage", "保管状況", 300, true], ["adherence", "服薬状況", 300, true], ["leftover", "残薬の状況", 300, true],
    ["guidance", "実施した指導", 400, true], ["report", "処方医への報告", 1200, true], ["shared", "他職種と共有した内容", 400, false],
  ], errors);
  fail(errors);
  const s = await db.prepare(
    "SELECT s.*, (SELECT 1 FROM visit_records WHERE schedule_id = s.id) AS done FROM visit_schedules s WHERE s.id = ?1",
  ).bind(scheduleId).first();
  if (!s) throw new HttpError(404, "訪問の予定が見つかりません");
  if (s.done) fail([{ path: "storage", message: "この訪問の記録はもう書かれています" }]);
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO visit_records (schedule_id, storage, adherence, leftover, guidance, report, shared, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id`,
    ).bind(scheduleId, v.storage, v.adherence, v.leftover, v.guidance, v.report, v.shared, nowIso(), user.id),
    auditStatement(db, user.id, "homecare.visit", s.patient_id, `${s.visit_on} の訪問記録`),
  ]);
  return { id: inserted.results[0].id };
}

// ---------- 一覧 ----------

const SCHEDULE_SELECT = `
  SELECT s.id, s.patient_id, s.visit_on, s.pharmacist_id, u.display_name AS pharmacist,
         pa.name, pa.kana, pa.patient_no, h.facility_id, f.name AS facility,
         v.id AS record_id, v.storage, v.adherence, v.leftover, v.guidance, v.report, v.shared, v.created_at AS recorded_at
    FROM visit_schedules s
    JOIN users u ON u.id = s.pharmacist_id
    JOIN patients pa ON pa.id = s.patient_id
    JOIN home_patients h ON h.patient_id = s.patient_id
    LEFT JOIN facilities f ON f.id = h.facility_id
    LEFT JOIN visit_records v ON v.schedule_id = s.id`;

function scheduleJson(r) {
  return {
    id: r.id, patientId: r.patient_id, visitOn: r.visit_on, pharmacistId: r.pharmacist_id, pharmacist: r.pharmacist,
    patient: { name: r.name, kana: r.kana, patientNo: r.patient_no }, facilityId: r.facility_id, facility: r.facility,
    record: r.record_id === null ? null : {
      id: r.record_id, storage: r.storage, adherence: r.adherence, leftover: r.leftover, guidance: r.guidance,
      report: r.report, shared: r.shared, recordedAt: r.recorded_at,
    },
  };
}

// 在宅の画面の中身：施設、在宅の患者（最新の計画書つき）、その月の訪問予定、薬剤師
export async function homeOverview(db, month) {
  const [facilities, patients, plans, schedules, users] = await db.batch([
    db.prepare("SELECT id, name, address, phone FROM facilities ORDER BY name"),
    db.prepare(
      `SELECT h.*, pa.name, pa.kana, pa.patient_no, pa.birth_date FROM home_patients h JOIN patients pa ON pa.id = h.patient_id ORDER BY pa.kana`,
    ),
    db.prepare("SELECT * FROM care_plans ORDER BY made_on DESC, id DESC"),
    db.prepare(`${SCHEDULE_SELECT} WHERE substr(s.visit_on, 1, 7) = ?1 ORDER BY s.visit_on, pa.kana`).bind(month),
    db.prepare("SELECT id, display_name FROM users ORDER BY id"),
  ]);
  const latestPlan = new Map();
  for (const p of plans.results) if (!latestPlan.has(p.patient_id)) latestPlan.set(p.patient_id, p);
  return {
    month,
    facilities: facilities.results,
    patients: patients.results.map((h) => ({
      patientId: h.patient_id, name: h.name, kana: h.kana, patientNo: h.patient_no, birthDate: h.birth_date,
      facilityId: h.facility_id, institution: h.institution, doctor: h.doctor, careManager: h.care_manager,
      intensive: h.intensive === 1, startedOn: h.started_on,
      plan: latestPlan.has(h.patient_id) ? planJson(latestPlan.get(h.patient_id)) : null,
    })),
    schedules: schedules.results.map(scheduleJson),
    pharmacists: users.results.map((u) => ({ id: u.id, name: u.display_name })),
  };
}

function planJson(p) {
  return {
    id: p.id, madeOn: p.made_on, management: p.management, drugNotes: p.drug_notes, guidance: p.guidance,
    visitsPerMonth: p.visits_per_month, intervalText: p.interval_text, reviewDue: planReviewDue(p.made_on),
  };
}

// 1人分：登録内容・計画書の履歴・全訪問
export async function homeDetail(db, patientId) {
  const h = await homePatient(db, patientId);
  const [info, plans, schedules] = await db.batch([
    db.prepare("SELECT pa.name, pa.kana, pa.patient_no, pa.birth_date, pa.sex, f.name AS facility FROM patients pa LEFT JOIN facilities f ON f.id = ?2 WHERE pa.id = ?1")
      .bind(patientId, h.facility_id),
    db.prepare("SELECT * FROM care_plans WHERE patient_id = ?1 ORDER BY made_on DESC, id DESC").bind(patientId),
    db.prepare(`${SCHEDULE_SELECT} WHERE s.patient_id = ?1 ORDER BY s.visit_on DESC`).bind(patientId),
  ]);
  return {
    patientId, facilityId: h.facility_id, institution: h.institution, doctor: h.doctor, careManager: h.care_manager,
    patient: { name: info.results[0].name, kana: info.results[0].kana, patientNo: info.results[0].patient_no, birthDate: info.results[0].birth_date, sex: info.results[0].sex },
    facility: info.results[0].facility,
    intensive: h.intensive === 1, startedOn: h.started_on,
    plans: plans.results.map(planJson), schedules: schedules.results.map(scheduleJson),
  };
}

// 報告書の印刷用：記録の済んだ訪問を集める。scheduleId を渡せばその1件、
// そうでなければ月と施設（"home"＝自宅の患者、"all"＝全員、数字＝その施設）で集める
export async function reportsFor(db, { month, facilityId, scheduleId = null }) {
  let where = "v.id IS NOT NULL";
  const binds = [];
  if (scheduleId !== null) {
    where += " AND s.id = ?1";
    binds.push(scheduleId);
  } else {
    where += " AND substr(s.visit_on, 1, 7) = ?1";
    binds.push(month);
    if (facilityId === "home") where += " AND h.facility_id IS NULL";
    else if (facilityId !== "all") {
      where += " AND h.facility_id = ?2";
      binds.push(Number(facilityId));
    }
  }
  const { results } = await db.prepare(`${SCHEDULE_SELECT} WHERE ${where} ORDER BY f.name, pa.kana, s.visit_on`).bind(...binds).all();
  const homes = await db.prepare("SELECT patient_id, institution, doctor, care_manager FROM home_patients").all();
  const byPatient = new Map(homes.results.map((h) => [h.patient_id, h]));
  return results.map((r) => {
    const h = byPatient.get(r.patient_id);
    return { ...scheduleJson(r), institution: h.institution, doctor: h.doctor, careManager: h.care_manager };
  });
}
