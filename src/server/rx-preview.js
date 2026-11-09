// 処方入力の途中の計算（薬剤料・比較日の点数・会計・小児の分量）。画面は入力を送り、結果だけを受け取って表示する。
// 計算の規則（src/rules/）は画面に配らない。保存時は prescriptions.js が同じ規則で計算し直す。
import { calcRp, dailyCost, formatYen, specialFee } from "../rules/yakuzairyo.js";
import { calcFees, copayYen } from "../rules/chozai-fee.js";
import { applyKohi } from "../rules/kohi.js";
import { checkPediatricDose, CHILD_AGE_LIMIT } from "../rules/pediatric-dose.js";
import { latestByItem } from "../../public/assets/js/lab-items.js";
import { ageOn } from "../../public/assets/js/format.js";
import { HttpError, isDate } from "./http.js";
import { pricesAt } from "./prices.js";
import { feeContext, feeLookup } from "./fees.js";
import { kohiForPrescription } from "./kohi.js";
import { measurementsOf } from "./measurements.js";
import { HANDBOOK, INQUIRY_KINDS, DAYS_CHANGES } from "./prescriptions.js";

const MAX_RPS = 20;
const MAX_ITEMS_PER_RP = 15;

// body：{ patientId, dispensedOn, compareOn, handbook, pending, inquiries: [{ kind, changed, shortReason }], kohi: [{ kohiId, priorMonthYen }],
//         rps: [{ r, usage, days, rxDays, daysChange, complete, items: [{ i, drugCode, dailyQtyMilli }] }] }
//   complete：その剤の薬・1日量・日数が揃っている（剤の点数を出す）。items は1日量まで入った薬だけ
export async function previewPrescription(db, body) {
  const bad = (m) => { throw new HttpError(400, m); };
  if (!isDate(body.dispensedOn)) bad("調剤日が不正です");
  if (body.compareOn !== null && !isDate(body.compareOn)) bad("比べる日付が不正です");
  if (!HANDBOOK.includes(body.handbook)) bad("お薬手帳の提示が不正です");
  if (!Array.isArray(body.rps) || body.rps.length > MAX_RPS) bad("剤の形が不正です");
  if (!Array.isArray(body.inquiries) || body.inquiries.some((q) => !INQUIRY_KINDS.includes(q.kind) || typeof q.changed !== "boolean")) bad("疑義照会の形が不正です");
  for (const rp of body.rps) {
    if (!Array.isArray(rp.items) || rp.items.length > MAX_ITEMS_PER_RP) bad("薬の形が不正です");
    for (const it of rp.items) {
      if (!/^6\d{8}$/.test(String(it.drugCode)) || !Number.isInteger(it.dailyQtyMilli) || it.dailyQtyMilli <= 0) bad("薬の形が不正です");
    }
    if (rp.complete && (!Number.isInteger(rp.days) || rp.days < 1 || !Number.isInteger(rp.rxDays) || rp.rxDays < rp.days)) bad("日数が不正です");
    if (rp.complete && rp.days < rp.rxDays && !DAYS_CHANGES.includes(rp.daysChange)) bad("日数を減らした根拠が不正です");
  }

  const codes = body.rps.flatMap((rp) => rp.items.map((it) => it.drugCode));
  const prices = await pricesAt(db, codes, body.dispensedOn);
  const comparePrices = body.compareOn === null ? null : await pricesAt(db, codes, body.compareOn);
  const okPrice = (map, code) => (map.get(code)?.status === "ok" ? map.get(code) : null);

  const items = [];
  const rps = [];
  for (const rp of body.rps) {
    for (const it of rp.items) {
      const d = okPrice(prices, it.drugCode);
      if (d) items.push({ r: rp.r, i: it.i, costYen: formatYen(dailyCost([{ priceSen: d.priceSen, dailyQtyMilli: it.dailyQtyMilli }])) });
    }
    if (!rp.complete || rp.items.length === 0 || !rp.items.every((it) => okPrice(prices, it.drugCode))) continue;
    const calcs = rp.items.map((it) => {
      const d = prices.get(it.drugCode);
      return { priceSen: d.priceSen, dailyQtyMilli: it.dailyQtyMilli, diffSen: d.diffSen, narcotic: d.narcotic };
    });
    const result = calcRp({ items: calcs, days: rp.days });
    let comparePoints = null;
    if (comparePrices && rp.items.every((it) => okPrice(comparePrices, it.drugCode))) {
      comparePoints = calcRp({ items: rp.items.map((it) => ({ priceSen: comparePrices.get(it.drugCode).priceSen, dailyQtyMilli: it.dailyQtyMilli })), days: rp.days }).points;
    }
    rps.push({
      r: rp.r, days: rp.days, rxDays: rp.rxDays, daysChange: rp.days < rp.rxDays ? rp.daysChange : null, calcs,
      result: { dailyYen: result.dailyYen, pointsPerDay: result.pointsPerDay, days: result.days, points: result.points }, comparePoints,
    });
  }
  const drugPoints = rps.reduce((s, x) => s + x.result.points, 0);

  return {
    items,
    rps: rps.map(({ r, result, comparePoints }) => ({ r, ...result, comparePoints })),
    drugPoints,
    compare: comparePrices === null || rps.length === 0 ? null : {
      usable: rps.every((x) => x.comparePoints !== null),
      oldPoints: rps.every((x) => x.comparePoints !== null) ? rps.reduce((s, x) => s + x.comparePoints, 0) : null,
    },
    bill: body.pending || rps.length === 0 ? null : await bill(db, body, rps, drugPoints),
    pediatric: await pediatric(db, body, prices),
  };
}

async function bill(db, body, rps, drugPoints) {
  let ctx;
  try {
    ctx = await feeContext(db, body.patientId, body.dispensedOn);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return { error: e.message };
  }
  const fees = calcFees({
    date: body.dispensedOn,
    facility: ctx.facility,
    ageYears: ctx.ageYears,
    handbook: body.handbook,
    history: { within3Months: ctx.history.within3Months, done: new Set(ctx.history.done) },
    rps: rps.map((x) => ({ days: x.days, rxDays: x.rxDays, daysChange: x.daysChange, narcotics: x.calcs.map((c) => c.narcotic) })),
    inquiries: body.inquiries.map((q) => ({ kind: q.kind, changed: q.changed, shortReason: String(q.shortReason ?? "").trim() || null })),
    fee: feeLookup(ctx.fees, body.dispensedOn),
  });
  const total = fees.tech + fees.mgmt + drugPoints + fees.other;
  const copay = copayYen(total, ctx.burdenPercent);
  const special = specialFee(rps.map((x) => ({ days: x.days, items: x.calcs })), body.dispensedOn);
  const kohi = await kohiForPrescription(db, body.patientId, body.dispensedOn, body.kohi);
  const applied = applyKohi({ totalPoints: total, burdenPercent: ctx.burdenPercent, copayYen: copay, kohi });
  return {
    tech: fees.tech, mgmt: fees.mgmt, drug: drugPoints, other: fees.other, total, copayYen: copay,
    specialYen: special?.yen ?? null, kohiSteps: applied.steps, chargeYen: applied.patientPayYen + (special?.yen ?? 0),
    lines: fees.lines.map((l) => ({ name: l.name, points: l.points, count: l.count })),
  };
}

// 調剤日の年齢が15歳未満なら、薬ごとに体重当たりの量を添付文書の小児の用量と比べる
async function pediatric(db, body, prices) {
  const p = await db.prepare("SELECT birth_date FROM patients WHERE id = ?1").bind(body.patientId).first();
  const age = ageOn(p.birth_date, body.dispensedOn);
  if (age >= CHILD_AGE_LIMIT) return null;
  const weight = latestByItem(await measurementsOf(db, body.patientId), body.dispensedOn).weight ?? null;
  const rows = [];
  for (const rp of body.rps) {
    for (const it of rp.items) {
      const drug = prices.get(it.drugCode);
      if (!drug || drug.status !== "ok") continue;
      const r = checkPediatricDose({ drug, dailyQtyMilli: it.dailyQtyMilli, usage: rp.usage, weightMilli: weight?.valueMilli ?? null });
      if (r) rows.push({ name: drug.name, ...r });
    }
  }
  return { age, weight: weight && { valueMilli: weight.valueMilli, measuredOn: weight.measuredOn }, rows };
}
