// 受付と業務の進み具合（受付 → 入力 → 監査 → 投薬 → 会計）。薬局の中で「今どの患者がどこまで進んでいて、何分待っているか」を共有する。
// 入力済みは処方を保存したとき、監査済みは調剤監査を保存したときに、それぞれの保存処理が足す。投薬・会計は画面のボタンで足す。
import { HttpError, isDate, nowIso } from "./http.js";
import { auditStatement } from "./audit.js";

export const STEPS = ["entered", "audited", "handed", "paid"];
const MANUAL_STEPS = { handed: "audited", paid: "handed" }; // 画面から足せる段階 → その前に済んでいる必要がある段階

export async function createReception(db, user, body) {
  if (!Number.isInteger(body.patientId)) throw new HttpError(422, "入力に誤りがあります", [{ path: "patientId", message: "患者を選んでください" }]);
  const patient = await db.prepare("SELECT id FROM patients WHERE id = ?1").bind(body.patientId).first();
  if (!patient) throw new HttpError(404, "患者が見つかりません");
  // 会計まで済んでいない受付が残っている患者は、重ねて受け付けない（二重受付の防止）
  const open = await db.prepare(
    `SELECT r.id FROM receptions r WHERE r.patient_id = ?1
        AND NOT EXISTS (SELECT 1 FROM reception_steps s WHERE s.reception_id = r.id AND s.step = 'paid')`,
  ).bind(body.patientId).first();
  if (open) throw new HttpError(422, "入力に誤りがあります", [{ path: "patientId", message: "この患者は会計が済んでいない受付があります" }]);
  const now = nowIso();
  const [inserted] = await db.batch([
    db.prepare("INSERT INTO receptions (patient_id, received_at, created_by) VALUES (?1, ?2, ?3) RETURNING id").bind(body.patientId, now, user.id),
    auditStatement(db, user.id, "reception.create", body.patientId, "処方箋を受付"),
  ]);
  return { id: inserted.results[0].id, receivedAt: now };
}

export async function addStep(db, user, receptionId, step) {
  if (!Object.hasOwn(MANUAL_STEPS, step)) throw new HttpError(422, "この段階は画面から進められません");
  const r = await db.prepare("SELECT id, patient_id FROM receptions WHERE id = ?1").bind(receptionId).first();
  if (!r) throw new HttpError(404, "受付が見つかりません");
  const { results } = await db.prepare("SELECT step FROM reception_steps WHERE reception_id = ?1").bind(receptionId).all();
  const done = new Set(results.map((x) => x.step));
  if (done.has(step)) throw new HttpError(422, "この段階はもう済んでいます");
  if (!done.has(MANUAL_STEPS[step])) throw new HttpError(422, `${STEP_LABEL[MANUAL_STEPS[step]]}が済んでいません`);
  await db.batch([
    db.prepare("INSERT INTO reception_steps (reception_id, step, at, user_id) VALUES (?1, ?2, ?3, ?4)").bind(receptionId, step, nowIso(), user.id),
    auditStatement(db, user.id, "reception.step", r.patient_id, STEP_LABEL[step]),
  ]);
}

export const STEP_LABEL = { entered: "入力", audited: "監査", handed: "投薬", paid: "会計" };

// その日（日本時間）の受付の一覧。古い順
export async function receptionsOn(db, date) {
  if (!isDate(date)) throw new HttpError(400, "日付が不正です");
  // received_at は UTC。日本時間の1日は前日 15:00Z 〜 当日 15:00Z
  const from = new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString();
  const to = new Date(Date.parse(`${date}T00:00:00+09:00`) + 86400000).toISOString();
  const [receptions, steps] = await db.batch([
    db.prepare(
      `SELECT r.id, r.patient_id, r.received_at, pa.name, pa.kana, pa.patient_no, p.id AS prescription_id,
              (SELECT COUNT(*) FROM inspections i WHERE i.prescription_id = p.id) AS inspections
         FROM receptions r JOIN patients pa ON pa.id = r.patient_id
         LEFT JOIN prescriptions p ON p.reception_id = r.id
        WHERE r.received_at >= ?1 AND r.received_at < ?2 ORDER BY r.received_at`,
    ).bind(from, to),
    db.prepare(
      `SELECT s.reception_id, s.step, s.at, u.display_name AS by FROM reception_steps s JOIN receptions r ON r.id = s.reception_id
         JOIN users u ON u.id = s.user_id WHERE r.received_at >= ?1 AND r.received_at < ?2`,
    ).bind(from, to),
  ]);
  const byReception = Map.groupBy(steps.results, (s) => s.reception_id);
  return receptions.results.map((r) => ({
    id: r.id, patientId: r.patient_id, receivedAt: r.received_at,
    patient: { name: r.name, kana: r.kana, patientNo: r.patient_no },
    prescriptionId: r.prescription_id, inspections: r.inspections,
    steps: Object.fromEntries((byReception.get(r.id) ?? []).map((s) => [s.step, { at: s.at, by: s.by }])),
  }));
}
