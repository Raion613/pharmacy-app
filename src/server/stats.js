// 薬局の数字（月ごと）。保存した処方から集計する。
//   処方箋の枚数      … その月の調剤日の処方の数（このアプリでは処方1件＝処方箋1枚）
//   処方箋単価        … 調剤報酬の合計点数 × 10円 ÷ 枚数（保険の分。選定療養の特別の料金は含めない）
//   後発医薬品の使用割合（数量ベース）… 後発医薬品の数量 ÷（後発医薬品のある先発医薬品の数量 ＋ 後発医薬品の数量）
//     数量は薬価基準の規格単位の数（1日量 × 日数）。後発医薬品は医薬品マスターの後発品区分、
//     「後発医薬品のある先発医薬品」は厚労省の薬価基準収載品目リストの欄（generic_flags）で見分ける
import { HttpError } from "./http.js";

export async function monthlyStats(db, { from, to }) {
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) throw new HttpError(400, "期間が不正です");
  const [rx, qty] = await db.batch([
    db.prepare(
      `SELECT substr(dispensed_on, 1, 7) AS month, COUNT(*) AS sheets, SUM(total_points) AS points, SUM(drug_points) AS drug_points
         FROM prescriptions WHERE substr(dispensed_on, 1, 7) BETWEEN ?1 AND ?2 GROUP BY month ORDER BY month`,
    ).bind(from, to),
    db.prepare(
      `SELECT substr(p.dispensed_on, 1, 7) AS month,
              SUM(CASE WHEN d.generic = 1 THEN i.daily_qty_milli * r.days ELSE 0 END) AS generic_milli,
              SUM(CASE WHEN d.generic = 0 AND g.yj_code IS NOT NULL THEN i.daily_qty_milli * r.days ELSE 0 END) AS original_milli
         FROM prescription_items i
         JOIN prescription_rps r ON r.id = i.rp_id
         JOIN prescriptions p ON p.id = r.prescription_id
         JOIN drugs d ON d.code = i.drug_code
         LEFT JOIN generic_flags g ON g.yj_code = d.yj_code
        WHERE substr(p.dispensed_on, 1, 7) BETWEEN ?1 AND ?2
        GROUP BY month`,
    ).bind(from, to),
  ]);
  const qtyByMonth = new Map(qty.results.map((q) => [q.month, q]));
  const months = [];
  for (let m = from; m <= to; m = nextMonth(m)) months.push(m);
  return months.map((month) => {
    const r = rx.results.find((x) => x.month === month);
    const q = qtyByMonth.get(month);
    const denom = q ? q.generic_milli + q.original_milli : 0;
    return {
      month,
      sheets: r?.sheets ?? 0,
      // 円未満は四捨五入（表示用）
      unitPriceYen: r ? Math.round((r.points * 10) / r.sheets) : null,
      drugPoints: r?.drug_points ?? 0,
      totalPoints: r?.points ?? 0,
      genericQtyMilli: q?.generic_milli ?? 0,
      originalQtyMilli: q?.original_milli ?? 0,
      // 割合は0.1%単位の整数（例 853 ＝ 85.3%）。分母が0の月は null
      genericPermille: denom === 0 ? null : Math.round((q.generic_milli * 1000) / denom),
    };
  });
}

function nextMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}
