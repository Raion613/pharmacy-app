// 改定をまたいで比べる：保存した処方（調剤日の薬価で計算済み）を、別の日付の薬価で計算し直して並べる。
// 薬歴の来局カードの「計算の内訳」から使う。比べる日付を指定しなければ、
// 処方の薬の薬価が調剤日より後で最初に変わる日。変わらなければ、いちばん最近変わった日の前日（前の薬価）
import { calcRp } from "../rules/yakuzairyo.js";
import { HttpError, isDate } from "./http.js";
import { pricesAt } from "./prices.js";

function dayBefore(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function compareRx(db, prescriptionId, date) {
  if (date !== null && !isDate(date)) throw new HttpError(400, "比べる日付が不正です");
  const rx = await db.prepare("SELECT dispensed_on, drug_points FROM prescriptions WHERE id = ?1").bind(prescriptionId).first();
  if (!rx) throw new HttpError(404, "処方が見つかりません");
  const { results } = await db.prepare(
    `SELECT r.rp_no, r.days, r.points, i.drug_code, i.daily_qty_milli, i.price_sen, d.name, d.unit
       FROM prescription_rps r JOIN prescription_items i ON i.rp_id = r.id JOIN drugs d ON d.code = i.drug_code
      WHERE r.prescription_id = ?1 ORDER BY r.rp_no, i.line_no`,
  ).bind(prescriptionId).all();
  const codes = results.map((x) => x.drug_code);

  let on = date;
  if (on === null) {
    const now = [...(await pricesAt(db, codes, rx.dispensed_on)).values()];
    on = now.map((d) => d.nextChangeOn).filter(Boolean).sort()[0] ?? dayBefore(now.map((d) => d.validFrom).filter(Boolean).sort().at(-1));
  }
  const then = await pricesAt(db, codes, on);

  const rps = [...Map.groupBy(results, (x) => x.rp_no).values()].map((rows) => {
    const items = rows.map((x) => {
      const p = then.get(x.drug_code);
      return {
        drugCode: x.drug_code, name: x.name, unit: x.unit, dailyQtyMilli: x.daily_qty_milli,
        priceSen: x.price_sen, comparePriceSen: p.status === "ok" ? p.priceSen : null, compareStatus: p.status,
      };
    });
    const usable = items.every((it) => it.comparePriceSen !== null);
    return {
      rpNo: rows[0].rp_no, days: rows[0].days, points: rows[0].points, items,
      comparePoints: usable ? calcRp({ items: items.map((it) => ({ priceSen: it.comparePriceSen, dailyQtyMilli: it.dailyQtyMilli })), days: rows[0].days }).points : null,
    };
  });
  const usable = rps.every((rp) => rp.comparePoints !== null);
  return {
    dispensedOn: rx.dispensed_on, date: on, rps,
    drugPoints: rx.drug_points, compareDrugPoints: usable ? rps.reduce((s, rp) => s + rp.comparePoints, 0) : null,
  };
}
