import { calcRp, parseQuantity, specialFee, dailyCost, formatYen } from "../rules/yakuzairyo.js";
import { calcFees, copayYen } from "../rules/chozai-fee.js";
import { HttpError, isDate, todayJst, daysBetween, nowIso } from "./http.js";
import { pricesAt, STATUS_MESSAGE } from "./prices.js";
import { feeContext, feeLookup } from "./fees.js";
import { auditStatement } from "./audit.js";
import { recordsByPrescription, conversationsByPrescription } from "./records.js";
import { burdenProblem } from "../rules/burden.js";
import { applyKohi, kohiName } from "../rules/kohi.js";
import { kohiForPrescription } from "./kohi.js";

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
        id: Number.isInteger(q.id) ? q.id : null, // 直すとき：前からある照会（記録した日時と人を残す）
        rpNo: q.rpNo ?? null,
        drugCode: q.drugCode ?? null,
        kind: q.kind,
        content: text(q.content, `${p}.content`, "問い合わせた内容", 400),
        answer: text(q.answer, `${p}.answer`, "処方医の回答", 400),
        changed: q.changed,
        shortReason: shortReason || null,
      });
    });
  }
  // 処方が変わった照会。rpNo を渡すと、その剤についての照会（か処方全体の照会）だけ
  const changedBy = (kind, rpNo = null) => inquiries.some((q) => q.changed && (kind === null || q.kind === kind) && (rpNo === null || q.rpNo === null || q.rpNo === rpNo));

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
        else if (daysChange === "inquiry" && !changedBy("leftover", i + 1)) err(`${p}.daysChange`, "この剤の残薬調整の疑義照会（処方の変更あり）を入力してください");
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
            else if (it.rx.reason === "inquiry" && !changedBy(null, i + 1)) err(`${q}.rx.reason`, "処方が変わった疑義照会を入力してください");
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

  // 照会の対象（剤・薬）が、送られた処方の中にあるか
  inquiries.forEach((q, n) => {
    if (q.rpNo === null) {
      if (q.drugCode !== null) err(`inquiries.${n}.target`, "薬を指すときは剤も指してください");
      return;
    }
    const rp = Number.isInteger(q.rpNo) ? rps[q.rpNo - 1] : undefined;
    if (!rp) err(`inquiries.${n}.target`, "照会の対象の剤がありません");
    else if (q.drugCode !== null && !rp.items.some((it) => it.drugCode === q.drugCode)) err(`inquiries.${n}.target`, `照会の対象の薬が Rp${q.rpNo} にありません`);
  });

  if (errors.length > 0) throw new HttpError(422, "入力に誤りがあります", errors);
  return { patientId: body.patientId, prescribedOn, dispensedOn, handbook: body.handbook, rps, inquiries, receptionId, kohi: body.kohi };
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
                                  copay_yen, special_fee_yen, special_fee_method, reception_id, created_at, created_by, burden_reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    ).bind(id, rx.patientId, rx.prescribedOn, rx.dispensedOn, rx.handbook, bill.drugPoints, bill.totalPoints, bill.burdenPercent,
      bill.copayYen, bill.special?.yen ?? null, bill.special?.method ?? null, rx.receptionId, now, user.id, bill.burdenReason),
    handbookStatement(db, rx),
    ...childStatements(db, id, rx, bill, user, now),
    // 在庫から、渡した量（1日量 × 調剤した日数）を引く
    ...stockStatements(db, user, now, givenOf(bill.rps)),
  ];
  // 受付から入力したときは、業務の進み具合に「入力済み」を足す
  if (rx.receptionId !== null) {
    statements.push(db.prepare("INSERT INTO reception_steps (reception_id, step, at, user_id) VALUES (?1, 'entered', ?2, ?3)").bind(rx.receptionId, now, user.id));
  }
  statements.push(auditStatement(db, user.id, "prescription.create", rx.patientId,
    `調剤日 ${rx.dispensedOn} / 合計 ${bill.totalPoints}点（薬剤料 ${bill.drugPoints}点）/ 一部負担金 ${bill.copayYen}円${
      bill.kohi.steps.length ? ` / 公費の後 ${bill.kohi.patientPayYen}円` : ""}${bill.special ? ` / 特別の料金 ${bill.special.yen}円` : ""}`));

  await db.batch(statements);
  return {
    id, drugPoints: bill.drugPoints, totalPoints: bill.totalPoints, copayYen: bill.copayYen, patientPayYen: bill.kohi.patientPayYen,
    specialFeeYen: bill.special?.yen ?? null,
  };
}

// 保存した処方を直す（会計の後でも）。処方の ID はそのまま、中身を今の入力に差し替え、直す前の処方を prescription_revisions に丸ごと残す。
//   渡す薬・量が変わったら、受付の段階を「入力済み」に戻す（監査から やり直す。前の監査の記録は残る）
//   会計の後で窓口の額が変わったら、会計済みを外す（受け取った額との差を、追加で受け取るか返す）
//   在庫は、直す前に渡した量を戻し、直した後の量を引く。受付・患者は変えられない
export async function revisePrescription(db, user, prescriptionId, body) {
  const row = await db.prepare("SELECT patient_id, reception_id FROM prescriptions WHERE id = ?1").bind(prescriptionId).first();
  if (!row) throw new HttpError(404, "処方が見つかりません");
  if (body.patientId !== row.patient_id) throw new HttpError(422, "入力に誤りがあります", [{ path: "patientId", message: "この処方の患者ではありません" }]);
  const rx = validatePrescription({ ...body, receptionId: row.reception_id });
  const before = (await prescriptionsOf(db, row.patient_id)).find((p) => p.id === prescriptionId);
  const bill = await billPrescription(db, rx, prescriptionId);

  const [steps, lastRevision, oldInquiries] = await db.batch([
    db.prepare("SELECT step, at FROM reception_steps WHERE reception_id = ?1").bind(row.reception_id),
    db.prepare("SELECT received_yen FROM prescription_revisions WHERE prescription_id = ?1 ORDER BY id DESC LIMIT 1").bind(prescriptionId),
    db.prepare("SELECT * FROM inquiries WHERE prescription_id = ?1").bind(prescriptionId),
  ]);
  const stepAt = Object.fromEntries(steps.results.map((s) => [s.step, s.at]));
  const beforePay = before.patientPayYen + (before.specialFeeYen ?? 0);
  const afterPay = bill.kohi.patientPayYen + (bill.special?.yen ?? 0);
  // 窓口でもう受け取っている額：会計済みなら直す前の額。会計済みを外した後でまだ受け取っていなければ、前の訂正のときの額のまま
  const receivedYen = stepAt.paid ? beforePay : (lastRevision.results[0]?.received_yen ?? null);

  const givenBefore = givenOf(before.rps.map((rp) => ({ days: rp.days, items: rp.items })));
  const givenAfter = givenOf(bill.rps);
  const contentChanged = givenBefore.size !== givenAfter.size || [...givenAfter].some(([code, milli]) => givenBefore.get(code) !== milli);
  const summary = revisionSummary(before, rx, bill, beforePay, afterPay);
  if (summary.length === 0) throw new HttpError(422, "直す前と同じです", [{ path: "rps", message: "直す前と同じです。変えたところがありません" }]);

  // 戻す段階：薬・量が変われば監査から。額だけが変われば会計から
  const reopen = contentChanged ? ["audited", "handed", "paid"].filter((s) => stepAt[s]) : stepAt.paid && afterPay !== receivedYen ? ["paid"] : [];

  // 照会は、直していない行（同じ ID で中身も同じ）なら、最初に記録した日時と人を残す
  const oldById = new Map(oldInquiries.results.map((q) => [q.id, q]));
  const keepInquiry = (q) => {
    const o = q.id === null ? undefined : oldById.get(q.id);
    const same = o && o.kind === q.kind && o.content === q.content && o.answer === q.answer && (o.changed === 1) === q.changed
      && o.short_reason === q.shortReason && o.rp_no === q.rpNo && o.drug_code === q.drugCode;
    return same ? { id: o.id, createdAt: o.created_at, createdBy: o.created_by } : null;
  };

  const now = nowIso();
  const net = new Map(givenAfter);
  for (const [code, milli] of givenBefore) net.set(code, (net.get(code) ?? 0) - milli);
  const { records: _r, conversations: _c, checks: _k, revisions: _v, ...snapshot } = before;
  const statements = [
    db.prepare(
      `INSERT INTO prescription_revisions (prescription_id, before_json, summary, content_changed, received_yen, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(prescriptionId, JSON.stringify({ prescription: snapshot, steps: stepAt }), summary.join("／"), contentChanged ? 1 : 0, receivedYen, now, user.id),
    db.prepare("DELETE FROM prescription_items WHERE rp_id IN (SELECT id FROM prescription_rps WHERE prescription_id = ?1)").bind(prescriptionId),
    ...["prescription_rps", "prescription_fees", "prescription_kohi", "inquiries"].map((t) => db.prepare(`DELETE FROM ${t} WHERE prescription_id = ?1`).bind(prescriptionId)),
    db.prepare(
      `UPDATE prescriptions SET prescribed_on = ?2, dispensed_on = ?3, handbook = ?4, drug_points = ?5, total_points = ?6, burden_percent = ?7,
              burden_reason = ?8, copay_yen = ?9, special_fee_yen = ?10, special_fee_method = ?11 WHERE id = ?1`,
    ).bind(prescriptionId, rx.prescribedOn, rx.dispensedOn, rx.handbook, bill.drugPoints, bill.totalPoints, bill.burdenPercent,
      bill.burdenReason, bill.copayYen, bill.special?.yen ?? null, bill.special?.method ?? null),
    handbookStatement(db, rx),
    ...childStatements(db, prescriptionId, rx, bill, user, now, keepInquiry),
    ...stockStatements(db, user, now, net),
    ...reopen.map((s) => db.prepare("DELETE FROM reception_steps WHERE reception_id = ?1 AND step = ?2").bind(row.reception_id, s)),
    auditStatement(db, user.id, "prescription.revise", rx.patientId, `調剤日 ${rx.dispensedOn} の処方を直した：${summary.join("／")}`),
  ];
  await db.batch(statements);
  return {
    id: prescriptionId, totalPoints: bill.totalPoints, patientPayYen: bill.kohi.patientPayYen, specialFeeYen: bill.special?.yen ?? null,
    payYen: afterPay, receivedYen, contentChanged, reopened: reopen, summary,
  };
}

// 渡す薬ごとの総量（1日量 × 調剤した日数）。同じ薬が2つの剤にあれば足す
function givenOf(rps) {
  const map = new Map();
  for (const rp of rps) for (const it of rp.items) map.set(it.drugCode, (map.get(it.drugCode) ?? 0) + it.dailyQtyMilli * rp.days);
  return map;
}

// 在庫から引く（マイナスの量なら戻す）。在庫を記録していない薬（行が無い）はそのまま
function stockStatements(db, user, now, given) {
  return [...given].filter(([, milli]) => milli !== 0).map(([code, milli]) =>
    db.prepare("UPDATE drug_stock SET qty_milli = qty_milli - ?1, updated_at = ?2 WHERE pharmacy_id = ?3 AND drug_code = ?4").bind(milli, now, user.pharmacy_id, code));
}

// 患者のお薬手帳の形態：紙・電子版を出されたらそれにする。「提示なし」は忘れただけのこともあるので、まだ聞いていないときだけ「持っていない」にする
function handbookStatement(db, rx) {
  return db.prepare("UPDATE patients SET handbook_kind = CASE WHEN ?1 <> 'none' THEN ?1 ELSE COALESCE(handbook_kind, 'none') END WHERE id = ?2")
    .bind(rx.handbook, rx.patientId);
}

// 剤・薬・疑義照会・算定項目・公費の行（新しく保存するときと、直すときで同じ）
function childStatements(db, id, rx, bill, user, now, keepInquiry = () => null) {
  const statements = bill.kohi.steps.map((s, i) => db.prepare(
    "INSERT INTO prescription_kohi (prescription_id, order_no, kohi_id, prior_month_yen, pay_yen) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).bind(id, i + 1, s.id, s.priorMonthYen, s.payYen));
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
    const kept = keepInquiry(q);
    statements.push(db.prepare(
      `INSERT INTO inquiries (id, prescription_id, kind, content, answer, changed, short_reason, created_at, created_by, rp_no, drug_code)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(kept?.id ?? null, id, q.kind, q.content, q.answer, q.changed ? 1 : 0, q.shortReason, kept?.createdAt ?? now, kept?.createdBy ?? user.id, q.rpNo, q.drugCode));
  }
  bill.fees.lines.forEach((l, i) => {
    statements.push(db.prepare(
      `INSERT INTO prescription_fees (prescription_id, line_no, section, code, name, points, count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(id, i + 1, l.section, l.code, l.name, l.points, l.count));
  });
  return statements;
}

// 直す前と後で何が変わったか（画面と閲覧記録に出す文）
function revisionSummary(before, rx, bill, beforePay, afterPay) {
  const out = [];
  const HANDBOOK_TEXT = { paper: "紙", electronic: "電子版", none: "提示なし" };
  if (before.prescribedOn !== rx.prescribedOn) out.push(`処方日 ${before.prescribedOn} → ${rx.prescribedOn}`);
  if (before.dispensedOn !== rx.dispensedOn) out.push(`調剤日 ${before.dispensedOn} → ${rx.dispensedOn}`);
  if (before.handbook !== rx.handbook) out.push(`お薬手帳 ${HANDBOOK_TEXT[before.handbook]} → ${HANDBOOK_TEXT[rx.handbook]}`);
  const lines = (rps) => new Map(rps.flatMap((rp) => rp.items.map((it) => [`${it.drugCode}`, { name: it.name, qty: it.dailyQtyMilli, days: rp.days, usage: rp.usage }])));
  const a = lines(before.rps);
  const b = lines(bill.rps);
  const qty = (m) => (m / 1000).toString();
  for (const [code, x] of b) {
    const o = a.get(code);
    if (!o) out.push(`追加 ${x.name} 1日${qty(x.qty)}・${x.days}日分`);
    else {
      const d = [];
      if (o.qty !== x.qty) d.push(`1日量 ${qty(o.qty)} → ${qty(x.qty)}`);
      if (o.days !== x.days) d.push(`日数 ${o.days} → ${x.days}`);
      if (o.usage !== x.usage) d.push(`用法 ${o.usage} → ${x.usage}`);
      if (d.length) out.push(`${x.name} ${d.join("・")}`);
    }
  }
  for (const [code, o] of a) if (!b.has(code)) out.push(`削除 ${o.name}`);
  const sameRx = (x, y) => (x?.name ?? null) === (y?.name ?? null) && (x?.dailyQtyMilli ?? null) === (y?.dailyQtyMilli ?? null) && (x?.reason ?? null) === (y?.reason ?? null);
  const rxOf = (rps) => new Map(rps.flatMap((rp) => rp.items.map((it) => [it.drugCode, it.rx])));
  const ra = rxOf(before.rps);
  if ([...rxOf(bill.rps)].some(([code, r]) => ra.has(code) && !sameRx(ra.get(code), r))) out.push("処方箋の記載との違い");
  const rpDays = (rps) => rps.map((rp) => `${rp.rxDays}/${rp.daysChange}`).join(",");
  if (rpDays(before.rps) !== rpDays(bill.rps)) out.push("処方箋の日数・減らした根拠");
  const inq = (qs) => JSON.stringify(qs.map((q) => [q.kind, q.content, q.answer, q.changed, q.shortReason ?? null, q.rpNo, q.drugCode]));
  if (inq(before.inquiries) !== inq(rx.inquiries)) out.push("疑義照会");
  const kohi = (ks) => JSON.stringify(ks.map((k) => [k.id, k.priorMonthYen]));
  if (kohi(before.kohi) !== kohi(bill.kohi.steps)) out.push("公費");
  if (out.length > 0 && beforePay !== afterPay) out.push(`窓口 ${beforePay.toLocaleString()}円 → ${afterPay.toLocaleString()}円`);
  return out;
}

// 調剤日時点の薬価・点数表で、薬剤料・調剤報酬・一部負担金・特別の料金を出す。
// excludePrescriptionId：直している処方。自分自身を「前の来局」「もう算定した項目」に数えない
async function billPrescription(db, rx, excludePrescriptionId = null) {
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
      return { ...it, name: drug?.name, priceSen: drug?.priceSen, diffSen: drug?.diffSen ?? null, narcotic: drug?.narcotic };
    }),
  }));
  if (errors.length > 0) throw new HttpError(422, "調剤日時点で使えない薬があります", errors);

  let context;
  try {
    context = await feeContext(db, rx.patientId, rx.dispensedOn, { excludePrescriptionId });
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    throw new HttpError(422, "調剤日の算定の規則がありません", [{ path: "dispensedOn", message: e.message }]);
  }
  const burdenMessage = burdenProblem(context, rx.dispensedOn);
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
  const copay = copayYen(totalPoints, context.burdenPercent);
  const kohiList = await kohiForPrescription(db, rx.patientId, rx.dispensedOn, rx.kohi);
  const applied = applyKohi({ totalPoints, burdenPercent: context.burdenPercent, copayYen: copay, kohi: kohiList });
  const priorOf = new Map(kohiList.map((k) => [k.id, k.priorMonthYen]));
  return {
    rps: calculated, fees, special, drugPoints, totalPoints,
    burdenPercent: context.burdenPercent, burdenReason: context.burdenReason, copayYen: copay,
    kohi: { patientPayYen: applied.patientPayYen, steps: applied.steps.map((s) => ({ ...s, priorMonthYen: priorOf.get(s.id) })) },
  };
}

// 患者の薬歴（処方の一覧、新しい順）。剤と薬・疑義照会・算定項目まで入れて返す。
export async function prescriptionsOf(db, patientId) {
  const [rxs, rps, items, inquiries, fees, kohi, checks, revisions] = await db.batch([
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
    db.prepare(
      `SELECT x.*, k.kind, k.local_name, k.local_form, k.cap_yen, k.payer_no, k.recipient_no
         FROM prescription_kohi x JOIN prescriptions p ON p.id = x.prescription_id JOIN patient_kohi k ON k.id = x.kohi_id
        WHERE p.patient_id = ?1 ORDER BY x.order_no`,
    ).bind(patientId),
    db.prepare(
      `SELECT c.*, u.display_name FROM handover_checks c JOIN prescriptions p ON p.id = c.prescription_id JOIN users u ON u.id = c.user_id
        WHERE p.patient_id = ?1 ORDER BY c.id`,
    ).bind(patientId),
    db.prepare(
      `SELECT v.id, v.prescription_id, v.summary, v.content_changed, v.received_yen, v.created_at, u.display_name FROM prescription_revisions v
         JOIN prescriptions p ON p.id = v.prescription_id JOIN users u ON u.id = v.created_by WHERE p.patient_id = ?1 ORDER BY v.id`,
    ).bind(patientId),
  ]);
  const revisionsByRx = Map.groupBy(revisions.results, (v) => v.prescription_id);
  // 引き継ぎの確認：項目ごとに最後の行
  const checksByRx = new Map();
  for (const c of checks.results) {
    if (!checksByRx.has(c.prescription_id)) checksByRx.set(c.prescription_id, {});
    checksByRx.get(c.prescription_id)[c.item] = { checked: c.checked === 1, at: c.at, by: c.display_name };
  }
  const kohiByRx = Map.groupBy(kohi.results, (k) => k.prescription_id);

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
    burdenReason: rx.burden_reason,
    copayYen: rx.copay_yen,
    // 使った公費（国 → 自治体の順）。最後の pay が窓口で受け取る保険の分
    kohi: (kohiByRx.get(rx.id) ?? []).map((k) => ({
      id: k.kohi_id, name: kohiName({ kind: k.kind, localName: k.local_name }), kind: k.kind, payerNo: k.payer_no, recipientNo: k.recipient_no,
      capYen: k.cap_yen, priorMonthYen: k.prior_month_yen, payYen: k.pay_yen,
      monthTotalYen: k.prior_month_yen === null ? null : k.prior_month_yen + k.pay_yen,
    })),
    patientPayYen: (kohiByRx.get(rx.id) ?? []).at(-1)?.pay_yen ?? rx.copay_yen,
    specialFeeYen: rx.special_fee_yen,
    specialFeeMethod: rx.special_fee_method,
    createdAt: rx.created_at,
    createdBy: rx.created_by_name,
    receptionId: rx.reception_id,
    // 直した記録（古い順）。receivedYen は直した時点で窓口でもう受け取っていた額
    revisions: (revisionsByRx.get(rx.id) ?? []).map((v) => ({
      at: v.created_at, by: v.display_name, summary: v.summary, contentChanged: v.content_changed === 1, receivedYen: v.received_yen,
    })),
    checks: checksByRx.get(rx.id) ?? {},
    records: records.get(rx.id) ?? [], // 指導記録がまだ無い来局は空
    conversations: conversations.get(rx.id) ?? [],
    inquiries: (inquiriesByRx.get(rx.id) ?? []).map((q) => ({
      id: q.id, rpNo: q.rp_no, drugCode: q.drug_code,
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
        dailyYen: formatYen(dailyCost([{ priceSen: it.price_sen, dailyQtyMilli: it.daily_qty_milli }])), // 1剤1日分のうちこの薬の額
        diffSen: it.special_diff_sen,
        rx: it.rx_name === null ? null : { name: it.rx_name, dailyQtyMilli: it.rx_daily_qty_milli, reason: it.change_reason },
      })),
    })),
  }));
}

// 引き継ぎの確認を付ける・外す（行を足す）
export const HANDOVER_ITEMS = { plan: "前回の申し送り（P）に応えた", cautions: "アレルギー・副作用歴・併用薬を照らした", change: "処方が変わった理由を聞いた", soa: "S・O・A を書いた", nextp: "次回の P を書いた" };
export async function checkHandover(db, user, prescriptionId, body) {
  if (!Object.hasOwn(HANDOVER_ITEMS, body.item ?? "") || typeof body.checked !== "boolean") {
    throw new HttpError(422, "入力に誤りがあります", [{ path: "item", message: "確認の項目が不正です" }]);
  }
  const rx = await db.prepare("SELECT patient_id, dispensed_on FROM prescriptions WHERE id = ?1").bind(prescriptionId).first();
  if (!rx) throw new HttpError(404, "処方が見つかりません");
  const now = nowIso();
  await db.batch([
    db.prepare("INSERT INTO handover_checks (prescription_id, item, checked, at, user_id) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(prescriptionId, body.item, body.checked ? 1 : 0, now, user.id),
    auditStatement(db, user.id, "handover.check", rx.patient_id, `調剤日 ${rx.dispensed_on}：${HANDOVER_ITEMS[body.item]}${body.checked ? "" : "（外した）"}`),
  ]);
  return { item: body.item, checked: body.checked, at: now, by: user.display_name };
}
