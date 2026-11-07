import { calcRp, parseQuantity, specialFee } from "../../public/assets/js/yakuzairyo.js";
import { calcFees, copayYen } from "../../public/assets/js/chozai-fee.js";
import { HttpError, isDate, todayJst, daysBetween, nowIso } from "./http.js";
import { pricesAt, STATUS_MESSAGE } from "./prices.js";
import { feeContext, feeLookup } from "./fees.js";
import { auditStatement } from "./audit.js";
import { recordsByPrescription, conversationsByPrescription } from "./records.js";
import { burdenError } from "./patients.js";

const MAX_RPS = 20;
const MAX_ITEMS_PER_RP = 15;
const MAX_INQUIRIES = 10;
const MAX_DAYS = 365;          // 入力ミスを止めるための上限。薬ごとの投与日数制限は扱わない
const PRESCRIPTION_VALID_DAYS = 4; // 処方箋の使用期間：交付日を含めて4日以内

export const HANDBOOK = ["paper", "electronic", "none"];
export const CHANGE_REASONS = ["general", "generic", "inquiry"]; // 一般名処方の銘柄選択／後発品への変更調剤／照会による変更
export const DAYS_CHANGES = ["inquiry", "instruction"];          // 処方医への照会／処方箋の減数調剤の指示
export const INQUIRY_KINDS = ["leftover", "adverse"];            // 残薬調整／重複投薬・相互作用など

// 画面から来た処方を検証して、計算に使える形にそろえる。誤りは項目ごとにまとめて 422 で返す。
//
// 処方箋に書かれた内容と、実際に調剤した（渡した）内容は分けて持つ。
//   剤：rxDays（処方箋の日数）と days（調剤した日数）。減らしたら根拠（照会か、処方箋の減数調剤の指示か）が要る
//   薬：drugCode・dailyQty は調剤した薬。処方箋と違うときだけ rx: { name, dailyQty, reason } に処方箋の記載を入れる
//   疑義照会：inquiries（処方医に何を問い合わせ、どう答えがあり、処方が変わったか）
export function validatePrescription(body, today = todayJst()) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  const text = (v, path, label, max) => {
    const s = String(v ?? "").trim();
    if (s === "") err(path, `${label}を入力してください`);
    else if (s.length > max) err(path, `${label}は${max}文字までです`);
    return s;
  };

  if (!Number.isInteger(body.patientId)) err("patientId", "患者が選ばれていません");

  const { prescribedOn, dispensedOn } = body;
  if (!isDate(prescribedOn)) err("prescribedOn", "処方日を正しい日付で入力してください");
  if (!isDate(dispensedOn)) err("dispensedOn", "調剤日を正しい日付で入力してください");
  if (isDate(prescribedOn) && isDate(dispensedOn)) {
    if (dispensedOn > today) err("dispensedOn", "調剤日に未来の日付は入力できません");
    const gap = daysBetween(prescribedOn, dispensedOn);
    if (gap < 0) err("dispensedOn", "調剤日が処方日より前になっています");
    else if (gap >= PRESCRIPTION_VALID_DAYS) {
      err("dispensedOn", `処方箋の使用期間（交付日を含めて${PRESCRIPTION_VALID_DAYS}日以内）を過ぎています`);
    }
  }
  if (!HANDBOOK.includes(body.handbook)) err("handbook", "お薬手帳の提示を選んでください");
  const receptionId = body.receptionId ?? null;
  if (receptionId !== null && !Number.isInteger(receptionId)) err("receptionId", "受付の指定が不正です");

  const inquiries = [];
  if (!Array.isArray(body.inquiries)) err("inquiries", "疑義照会の形が不正です");
  else if (body.inquiries.length > MAX_INQUIRIES) err("inquiries", `疑義照会は${MAX_INQUIRIES}件までです`);
  else {
    body.inquiries.forEach((q, i) => {
      const p = `inquiries.${i}`;
      if (!INQUIRY_KINDS.includes(q.kind)) err(`${p}.kind`, "照会の内容の種類を選んでください");
      if (typeof q.changed !== "boolean") err(`${p}.changed`, "処方が変わったかを選んでください");
      const shortReason = String(q.shortReason ?? "").trim();
      if (shortReason.length > 200) err(`${p}.shortReason`, "理由は200文字までです");
      if (shortReason && q.kind !== "leftover") err(`${p}.shortReason`, "6日分以下の残薬調整の理由は、残薬調整の照会にだけ書けます");
      inquiries.push({
        kind: q.kind,
        content: text(q.content, `${p}.content`, "問い合わせた内容", 400),
        answer: text(q.answer, `${p}.answer`, "処方医の回答", 400),
        changed: q.changed,
        shortReason: shortReason || null,
      });
    });
  }
  const changedBy = (kind) => inquiries.some((q) => q.changed && (kind === null || q.kind === kind));

  const rps = [];
  if (!Array.isArray(body.rps) || body.rps.length === 0) err("rps", "薬が1つも入力されていません");
  else if (body.rps.length > MAX_RPS) err("rps", `剤は${MAX_RPS}剤までです`);
  else {
    body.rps.forEach((rp, i) => {
      const p = `rps.${i}`;
      const usage = String(rp.usage ?? "").trim();
      if (usage === "") err(`${p}.usage`, "用法を入力してください");
      else if (usage.length > 40) err(`${p}.usage`, "用法は40文字までです");

      const days = Number(rp.days);
      const rxDays = Number(rp.rxDays);
      const daysOk = Number.isInteger(days) && days >= 1 && days <= MAX_DAYS;
      const rxDaysOk = Number.isInteger(rxDays) && rxDays >= 1 && rxDays <= MAX_DAYS;
      if (!daysOk) err(`${p}.days`, `調剤した日数は1〜${MAX_DAYS}の整数で入力してください`);
      if (!rxDaysOk) err(`${p}.rxDays`, `処方箋の日数は1〜${MAX_DAYS}の整数で入力してください`);
      const daysChange = rp.daysChange ?? null;
      if (daysOk && rxDaysOk) {
        if (days > rxDays) err(`${p}.days`, "処方箋の日数より多くは調剤できません");
        else if (days < rxDays && !DAYS_CHANGES.includes(daysChange)) err(`${p}.daysChange`, "日数を減らした根拠（照会・処方箋の指示）を選んでください");
        else if (days === rxDays && daysChange !== null) err(`${p}.daysChange`, "日数を変えていないのに、変えた根拠が入っています");
        else if (daysChange === "inquiry" && !changedBy("leftover")) err(`${p}.daysChange`, "残薬調整の疑義照会（処方の変更あり）を入力してください");
      }

      const items = [];
      if (!Array.isArray(rp.items) || rp.items.length === 0) err(`${p}.items`, "この剤に薬がありません");
      else if (rp.items.length > MAX_ITEMS_PER_RP) err(`${p}.items`, `1剤の薬は${MAX_ITEMS_PER_RP}品目までです`);
      else {
        const seen = new Set();
        rp.items.forEach((it, j) => {
          const q = `${p}.items.${j}`;
          if (typeof it.drugCode !== "string" || !/^6\d{8}$/.test(it.drugCode)) {
            err(`${q}.drugCode`, "薬が選ばれていません");
            return;
          }
          if (seen.has(it.drugCode)) err(`${q}.drugCode`, "同じ剤に同じ薬が2回入っています");
          seen.add(it.drugCode);
          const milli = quantity(it.dailyQty, `${q}.dailyQty`, err);
          let rx = null;
          if (it.rx !== null && it.rx !== undefined) {
            if (!CHANGE_REASONS.includes(it.rx.reason)) err(`${q}.rx.reason`, "処方箋と違う理由を選んでください");
            else if (it.rx.reason === "inquiry" && !changedBy(null)) err(`${q}.rx.reason`, "処方が変わった疑義照会を入力してください");
            rx = {
              name: text(it.rx.name, `${q}.rx.name`, "処方箋に書かれた薬", 100),
              dailyQtyMilli: quantity(it.rx.dailyQty, `${q}.rx.dailyQty`, err),
              reason: it.rx.reason,
            };
          }
          if (milli !== null) items.push({ drugCode: it.drugCode, dailyQtyMilli: milli, rx });
        });
      }
      rps.push({ usage, days, rxDays, daysChange, items });
    });
  }

  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return { patientId: body.patientId, prescribedOn, dispensedOn, handbook: body.handbook, rps, inquiries, receptionId };
}

function quantity(value, path, err) {
  try {
    return parseQuantity(value);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    err(path, e.message);
    return null;
  }
}

// 調剤日時点の薬価と点数表で計算し、処方・剤・明細・疑義照会・算定項目・アクセスログを1つのトランザクションで保存する。
export async function createPrescription(db, user, body) {
  const rx = validatePrescription(body);
  if (rx.receptionId !== null) {
    const r = await db.prepare(
      "SELECT patient_id, (SELECT 1 FROM prescriptions WHERE reception_id = ?1) AS used FROM receptions WHERE id = ?1",
    ).bind(rx.receptionId).first();
    if (!r || r.patient_id !== rx.patientId) throw new HttpError(422, "入力に誤りがあります", [{ path: "receptionId", message: "この患者の受付ではありません" }]);
    if (r.used) throw new HttpError(422, "入力に誤りがあります", [{ path: "receptionId", message: "この受付の処方はもう入力されています" }]);
  }
  const bill = await billPrescription(db, rx);

  // ID を先に採番しておけば、親子の行を1回の batch でまとめて入れられる。
  // D1 の batch は1つのトランザクションとして実行され、途中の1文でも失敗すれば全部取り消される。
  const id = crypto.randomUUID();
  const now = nowIso();
  const statements = [
    db.prepare(
      `INSERT INTO prescriptions (id, patient_id, prescribed_on, dispensed_on, handbook, drug_points, total_points, burden_percent,
                                  copay_yen, special_fee_yen, special_fee_method, reception_id, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    ).bind(id, rx.patientId, rx.prescribedOn, rx.dispensedOn, rx.handbook, bill.drugPoints, bill.totalPoints, bill.burdenPercent,
      bill.copayYen, bill.special?.yen ?? null, bill.special?.method ?? null, rx.receptionId, now, user.id),
  ];
  // 受付から入力したときは、業務の進み具合に「入力済み」を足す
  if (rx.receptionId !== null) {
    statements.push(db.prepare("INSERT INTO reception_steps (reception_id, step, at, user_id) VALUES (?1, 'entered', ?2, ?3)").bind(rx.receptionId, now, user.id));
  }
  bill.rps.forEach((rp, i) => {
    const rpId = crypto.randomUUID();
    statements.push(
      db.prepare(
        `INSERT INTO prescription_rps (id, prescription_id, rp_no, usage, rx_days, days, days_change, daily_yen, points_per_day, points, special_points)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(rpId, id, i + 1, rp.usage, rp.rxDays, rp.days, rp.daysChange, rp.result.dailyYen, rp.result.pointsPerDay, rp.result.points, rp.specialPoints),
    );
    rp.items.forEach((it, j) => {
      statements.push(
        db.prepare(
          `INSERT INTO prescription_items (rp_id, line_no, drug_code, daily_qty_milli, price_sen, special_diff_sen,
                                           rx_name, rx_daily_qty_milli, change_reason)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).bind(rpId, j + 1, it.drugCode, it.dailyQtyMilli, it.priceSen, it.diffSen, it.rx?.name ?? null, it.rx?.dailyQtyMilli ?? null, it.rx?.reason ?? null),
      );
    });
  });
  for (const q of rx.inquiries) {
    statements.push(db.prepare(
      `INSERT INTO inquiries (prescription_id, kind, content, answer, changed, short_reason, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(id, q.kind, q.content, q.answer, q.changed ? 1 : 0, q.shortReason, now, user.id));
  }
  bill.fees.lines.forEach((l, i) => {
    statements.push(db.prepare(
      `INSERT INTO prescription_fees (prescription_id, line_no, section, code, name, points, count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(id, i + 1, l.section, l.code, l.name, l.points, l.count));
  });
  statements.push(auditStatement(db, user.id, "prescription.create", rx.patientId,
    `調剤日 ${rx.dispensedOn} / 合計 ${bill.totalPoints}点（薬剤料 ${bill.drugPoints}点）/ 一部負担金 ${bill.copayYen}円${bill.special ? ` / 特別の料金 ${bill.special.yen}円` : ""}`));

  await db.batch(statements);
  return { id, drugPoints: bill.drugPoints, totalPoints: bill.totalPoints, copayYen: bill.copayYen, specialFeeYen: bill.special?.yen ?? null };
}

// 調剤日時点の薬価・点数表で、薬剤料・調剤報酬・一部負担金・特別の料金を出す
async function billPrescription(db, rx) {
  const prices = await pricesAt(db, rx.rps.flatMap((rp) => rp.items.map((it) => it.drugCode)), rx.dispensedOn);
  const errors = [];
  const rps = rx.rps.map((rp, i) => ({
    ...rp,
    items: rp.items.map((it, j) => {
      const drug = prices.get(it.drugCode);
      if (!drug) errors.push({ path: `rps.${i}.items.${j}.drugCode`, message: "薬価マスタに無い薬です" });
      else if (drug.status !== "ok") {
        errors.push({ path: `rps.${i}.items.${j}.drugCode`, message: `${drug.name}：${STATUS_MESSAGE[drug.status]}` });
      }
      return { ...it, priceSen: drug?.priceSen, diffSen: drug?.diffSen ?? null, narcotic: drug?.narcotic };
    }),
  }));
  if (errors.length > 0) throw new HttpError(422, "調剤日時点で使えない薬があります", errors);

  let context;
  try {
    context = await feeContext(db, rx.patientId, rx.dispensedOn);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    throw new HttpError(422, "調剤日の算定の規則がありません", [{ path: "dispensedOn", message: e.message }]);
  }
  const burdenMessage = burdenError(context.birthDate, rx.dispensedOn, context.burdenPercent);
  if (burdenMessage) throw new HttpError(422, "負担割合を確かめてください", [{ path: "burden", message: `負担割合：${burdenMessage}` }]);

  const special = specialFee(rps, rx.dispensedOn);
  let k = 0;
  const calculated = rps.map((rp) => ({
    ...rp,
    result: calcRp(rp),
    // 特別の料金を点数で出す期間は、剤ごとの点数も残す（対象の薬が無い剤は NULL）
    specialPoints: special?.method === "points" && rp.items.some((it) => it.diffSen !== null) ? special.rps[k++].points : null,
  }));
  const drugPoints = calculated.reduce((sum, rp) => sum + rp.result.points, 0);
  const fees = calcFees({
    date: rx.dispensedOn,
    facility: context.facility,
    ageYears: context.ageYears,
    handbook: rx.handbook,
    history: { within3Months: context.history.within3Months, done: new Set(context.history.done) },
    rps: calculated.map((rp) => ({ days: rp.days, rxDays: rp.rxDays, daysChange: rp.daysChange, narcotics: rp.items.map((it) => it.narcotic) })),
    inquiries: rx.inquiries,
    fee: feeLookup(context.fees, rx.dispensedOn),
  });
  const totalPoints = fees.tech + fees.mgmt + drugPoints + fees.other;
  return {
    rps: calculated, fees, special, drugPoints, totalPoints,
    burdenPercent: context.burdenPercent, copayYen: copayYen(totalPoints, context.burdenPercent),
  };
}

// 患者の薬歴（処方の一覧、新しい順）。剤と薬・疑義照会・算定項目まで入れて返す。
export async function prescriptionsOf(db, patientId) {
  const [rxs, rps, items, inquiries, fees] = await db.batch([
    db.prepare(
      `SELECT p.*, u.display_name AS created_by_name
         FROM prescriptions p JOIN users u ON u.id = p.created_by
        WHERE p.patient_id = ?1
        ORDER BY p.dispensed_on DESC, p.created_at DESC`,
    ).bind(patientId),
    db.prepare(
      `SELECT r.* FROM prescription_rps r JOIN prescriptions p ON p.id = r.prescription_id
        WHERE p.patient_id = ?1 ORDER BY r.rp_no`,
    ).bind(patientId),
    db.prepare(
      `SELECT i.*, d.name, d.unit, d.sentei, d.yj_code, d.general_name, d.generic FROM prescription_items i
         JOIN prescription_rps r ON r.id = i.rp_id
         JOIN prescriptions p ON p.id = r.prescription_id
         JOIN drugs d ON d.code = i.drug_code
        WHERE p.patient_id = ?1 ORDER BY i.line_no`,
    ).bind(patientId),
    db.prepare(
      `SELECT q.*, u.display_name AS created_by_name FROM inquiries q JOIN prescriptions p ON p.id = q.prescription_id
         JOIN users u ON u.id = q.created_by WHERE p.patient_id = ?1 ORDER BY q.id`,
    ).bind(patientId),
    db.prepare(
      `SELECT f.* FROM prescription_fees f JOIN prescriptions p ON p.id = f.prescription_id
        WHERE p.patient_id = ?1 ORDER BY f.line_no`,
    ).bind(patientId),
  ]);

  const records = await recordsByPrescription(db, patientId);
  const conversations = await conversationsByPrescription(db, patientId);
  const itemsByRp = Map.groupBy(items.results, (it) => it.rp_id);
  const rpsByRx = Map.groupBy(rps.results, (rp) => rp.prescription_id);
  const inquiriesByRx = Map.groupBy(inquiries.results, (q) => q.prescription_id);
  const feesByRx = Map.groupBy(fees.results, (f) => f.prescription_id);
  return rxs.results.map((rx) => ({
    id: rx.id,
    prescribedOn: rx.prescribed_on,
    dispensedOn: rx.dispensed_on,
    handbook: rx.handbook,
    drugPoints: rx.drug_points,
    totalPoints: rx.total_points,
    burdenPercent: rx.burden_percent,
    copayYen: rx.copay_yen,
    specialFeeYen: rx.special_fee_yen,
    specialFeeMethod: rx.special_fee_method,
    createdAt: rx.created_at,
    createdBy: rx.created_by_name,
    receptionId: rx.reception_id,
    records: records.get(rx.id) ?? [], // 指導記録がまだ無い来局は空
    conversations: conversations.get(rx.id) ?? [],
    inquiries: (inquiriesByRx.get(rx.id) ?? []).map((q) => ({
      kind: q.kind, content: q.content, answer: q.answer, changed: q.changed === 1, shortReason: q.short_reason,
      createdAt: q.created_at, createdBy: q.created_by_name,
    })),
    fees: (feesByRx.get(rx.id) ?? []).map((f) => ({ section: f.section, code: f.code, name: f.name, points: f.points, count: f.count })),
    rps: rpsByRx.get(rx.id).map((rp) => ({
      rpNo: rp.rp_no,
      usage: rp.usage,
      rxDays: rp.rx_days,
      days: rp.days,
      daysChange: rp.days_change,
      dailyYen: rp.daily_yen,
      pointsPerDay: rp.points_per_day,
      points: rp.points,
      specialPoints: rp.special_points,
      items: itemsByRp.get(rp.id).map((it) => ({
        drugCode: it.drug_code,
        yjCode: it.yj_code,
        name: it.name,
        generalName: it.general_name,
        generic: it.generic === 1,
        unit: it.unit,
        sentei: it.sentei,
        dailyQtyMilli: it.daily_qty_milli,
        priceSen: it.price_sen,
        diffSen: it.special_diff_sen,
        rx: it.rx_name === null ? null : { name: it.rx_name, dailyQtyMilli: it.rx_daily_qty_milli, reason: it.change_reason },
      })),
    })),
  }));
}
