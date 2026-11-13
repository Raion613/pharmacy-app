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
    `SELECT r.id, r.received_at FROM receptions r WHERE r.patient_id = ?1
        AND NOT EXISTS (SELECT 1 FROM reception_steps s WHERE s.reception_id = r.id AND s.step = 'paid')`,
  ).bind(body.patientId).first();
  if (open) {
    // いつの受付かを言う（日本時間）。前の日の受付も、会計まで済んでいなければ受付状況に「前日から」で出ている
    const jst = new Date(Date.parse(open.received_at) + 9 * 3600000).toISOString();
    const day = `${Number(jst.slice(5, 7))}/${Number(jst.slice(8, 10))}`;
    throw new HttpError(422, "入力に誤りがあります", [{
      path: "patientId",
      message: `${day} ${jst.slice(11, 16)} の受付が、まだ会計まで済んでいません。受付状況のその受付から続けてください`,
    }]);
  }
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
  // 投薬は、薬歴でこの来局の指導記録を書いてから（服薬管理指導料の要件。書かずに会計まで流れないように）
  if (step === "handed") {
    const record = await db.prepare(
      "SELECT 1 FROM guidance_records g JOIN prescriptions p ON p.id = g.prescription_id WHERE p.reception_id = ?1 LIMIT 1",
    ).bind(receptionId).first();
    if (!record) throw new HttpError(422, "この来局の指導記録がまだありません。薬歴で指導記録を書いてください");
  }
  await db.batch([
    db.prepare("INSERT INTO reception_steps (reception_id, step, at, user_id) VALUES (?1, ?2, ?3, ?4)").bind(receptionId, step, nowIso(), user.id),
    auditStatement(db, user.id, "reception.step", r.patient_id, STEP_LABEL[step]),
  ]);
}

export const STEP_LABEL = { entered: "入力", audited: "監査", handed: "投薬", paid: "会計" };

// その日の受付と、それより前に受け付けて会計まで済んでいない受付（前日から持ち越した分。二重受付の防止で新しく受け付けられないので、見えないと続きができない）
const IN_DAY = `(r.received_at >= ?1 AND r.received_at < ?2
  OR r.received_at < ?1 AND NOT EXISTS (SELECT 1 FROM reception_steps x WHERE x.reception_id = r.id AND x.step = 'paid'))`;

// 自分の薬局の、その日（日本時間）の受付の一覧。古い順
export async function receptionsOn(db, pharmacyId, date) {
  if (!isDate(date)) throw new HttpError(400, "日付が不正です");
  // received_at は UTC。日本時間の1日は前日 15:00Z 〜 当日 15:00Z
  const from = new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString();
  const to = new Date(Date.parse(`${date}T00:00:00+09:00`) + 86400000).toISOString();
  const [receptions, steps] = await db.batch([
    db.prepare(
      `SELECT r.id, r.patient_id, r.received_at, pa.name, pa.kana, pa.patient_no, p.id AS prescription_id,
              (SELECT COUNT(*) FROM inspections i WHERE i.prescription_id = p.id) AS inspections,
              (SELECT COUNT(*) FROM guidance_records g WHERE g.prescription_id = p.id) AS records,
              -- 処方を直したとき：直した時点で窓口でもう受け取っていた額（最後の訂正）と、今の窓口の額
              (SELECT v.received_yen FROM prescription_revisions v WHERE v.prescription_id = p.id ORDER BY v.id DESC LIMIT 1) AS received_yen,
              COALESCE((SELECT k.pay_yen FROM prescription_kohi k WHERE k.prescription_id = p.id ORDER BY k.order_no DESC LIMIT 1), p.copay_yen)
                + COALESCE(p.special_fee_yen, 0) AS pay_yen
         FROM receptions r JOIN patients pa ON pa.id = r.patient_id
         LEFT JOIN prescriptions p ON p.reception_id = r.id
        WHERE pa.pharmacy_id = ?3 AND ${IN_DAY} ORDER BY r.received_at`,
    ).bind(from, to, pharmacyId),
    db.prepare(
      `SELECT s.reception_id, s.step, s.at, u.display_name AS by FROM reception_steps s JOIN receptions r ON r.id = s.reception_id
         JOIN patients pa ON pa.id = r.patient_id
         JOIN users u ON u.id = s.user_id WHERE pa.pharmacy_id = ?3 AND ${IN_DAY}`,
    ).bind(from, to, pharmacyId),
  ]);
  const byReception = Map.groupBy(steps.results, (s) => s.reception_id);
  return receptions.results.map((r) => ({
    id: r.id, patientId: r.patient_id, receivedAt: r.received_at, carriedOver: r.received_at < from,
    patient: { name: r.name, kana: r.kana, patientNo: r.patient_no },
    prescriptionId: r.prescription_id, inspections: r.inspections, records: r.records,
    receivedYen: r.received_yen, payYen: r.pay_yen,
    steps: Object.fromEntries((byReception.get(r.id) ?? []).map((s) => [s.step, { at: s.at, by: s.by }])),
  }));
}

// 受付の記録を消す（受け付けた処方箋と、そこから入力した処方・監査・指導記録・会話・引き継ぎの確認・訂正の記録まで）。
// 間違えて受け付けた・別の患者で入力した、を取り消すため。画面では2回確かめてから呼ぶ。
// 在庫は、渡した量を戻す。トレーシングレポートは医師に送った文書なので消さず、元にした来局とのつながりだけを外す。
// 何を消したかは閲覧記録に残る
export async function deleteReception(db, user, receptionId) {
  const r = await db.prepare(
    `SELECT r.patient_id, r.received_at, p.id AS rx_id, p.dispensed_on FROM receptions r LEFT JOIN prescriptions p ON p.reception_id = r.id WHERE r.id = ?1`,
  ).bind(receptionId).first();
  if (!r) throw new HttpError(404, "受付が見つかりません");
  const rx = r.rx_id;
  const statements = [];
  if (rx !== null) {
    const given = await db.prepare(
      `SELECT i.drug_code, SUM(i.daily_qty_milli * p.days) AS milli FROM prescription_items i JOIN prescription_rps p ON p.id = i.rp_id
        WHERE p.prescription_id = ?1 GROUP BY i.drug_code`,
    ).bind(rx).all();
    const inspections = "SELECT id FROM inspections WHERE prescription_id = ?1";
    statements.push(
      ...given.results.map((g) => db.prepare("UPDATE drug_stock SET qty_milli = qty_milli + ?1, updated_at = ?2 WHERE pharmacy_id = ?3 AND drug_code = ?4")
        .bind(g.milli, nowIso(), user.pharmacy_id, g.drug_code)),
      db.prepare(`DELETE FROM inspection_scans WHERE inspection_id IN (${inspections})`).bind(rx),
      db.prepare(`DELETE FROM inspection_visual_checks WHERE inspection_id IN (${inspections})`).bind(rx),
      db.prepare("DELETE FROM prescription_items WHERE rp_id IN (SELECT id FROM prescription_rps WHERE prescription_id = ?1)").bind(rx),
      ...["inspections", "guidance_records", "conversations", "handover_checks", "prescription_kohi", "prescription_fees", "inquiries",
        "prescription_rps", "prescription_revisions"].map((t) => db.prepare(`DELETE FROM ${t} WHERE prescription_id = ?1`).bind(rx)),
      db.prepare("UPDATE tracing_reports SET prescription_id = NULL WHERE prescription_id = ?1").bind(rx),
      db.prepare("DELETE FROM prescriptions WHERE id = ?1").bind(rx),
    );
  }
  const jst = new Date(Date.parse(r.received_at) + 9 * 3600000).toISOString();
  statements.push(
    db.prepare("DELETE FROM reception_steps WHERE reception_id = ?1").bind(receptionId),
    db.prepare("DELETE FROM receptions WHERE id = ?1").bind(receptionId),
    auditStatement(db, user.id, "reception.delete", r.patient_id,
      `${jst.slice(0, 10)} ${jst.slice(11, 16)} の受付を削除${rx === null ? "" : `（調剤日 ${r.dispensed_on} の処方と、その監査・指導記録も削除）`}`),
  );
  await db.batch(statements);
}
