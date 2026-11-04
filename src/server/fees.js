// 調剤報酬の算定に要る「その日の事実」を DB から集める。算定の規則そのものは public/assets/js/chozai-fee.js。
//   - その日に効いている算定項目の点数（調剤行為マスターの履歴）
//   - その日に効いている薬局の届出（施設基準）
//   - この患者の履歴（3月以内の再来局か、月1回などの項目をもう算定したか）
import { ALL_CODES, LIMITED, eraOf, pointsOf } from "../../public/assets/js/chozai-fee.js";
import { HttpError } from "./http.js";

export async function feeContext(db, patientId, date, { excludePrescriptionId = null } = {}) {
  eraOf(date); // 規則の無い日付ならここで止める
  const placeholders = ALL_CODES.map((_, i) => `?${i + 2}`).join(", ");
  const [patient, facility, fees, recent, done] = await db.batch([
    db.prepare("SELECT birth_date, burden_percent FROM patients WHERE id = ?1").bind(patientId),
    db.prepare("SELECT * FROM pharmacy_facility WHERE valid_from <= ?1 ORDER BY valid_from DESC LIMIT 1").bind(date),
    db.prepare(`
      SELECT f.code, p.name, p.point_kind, p.points_x100
        FROM fee_items f
        JOIN fee_points p ON p.code = f.code
         AND p.valid_from = (SELECT MAX(x.valid_from) FROM fee_points x WHERE x.code = f.code AND x.valid_from <= ?1)
       WHERE f.code IN (${placeholders}) AND p.points_x100 IS NOT NULL`).bind(date, ...ALL_CODES),
    // 原則3月以内に再度処方箋を持参したか（服薬管理指導料の区分）
    db.prepare(`SELECT COUNT(*) AS n FROM prescriptions
                 WHERE patient_id = ?1 AND dispensed_on BETWEEN date(?2, '-3 months') AND ?2 AND id IS NOT ?3`)
      .bind(patientId, date, excludePrescriptionId),
    // 回数に限りのある項目を、もう算定したか（月1回は同じ暦月、12月・3月は調剤日からさかのぼって）
    db.prepare(`
      SELECT DISTINCT f.code FROM prescription_fees f JOIN prescriptions p ON p.id = f.prescription_id
       WHERE p.patient_id = ?1 AND p.id IS NOT ?2 AND p.dispensed_on <= ?3 AND (
             (f.code IN (SELECT value FROM json_each(?4)) AND strftime('%Y-%m', p.dispensed_on) = strftime('%Y-%m', ?3))
          OR (f.code IN (SELECT value FROM json_each(?5)) AND p.dispensed_on > date(?3, '-12 months'))
          OR (f.code IN (SELECT value FROM json_each(?6)) AND p.dispensed_on > date(?3, '-3 months')))`)
      .bind(patientId, excludePrescriptionId, date, JSON.stringify(LIMITED.month), JSON.stringify(LIMITED.months12), JSON.stringify(LIMITED.months3)),
  ]);
  const p = patient.results[0];
  if (!p) throw new HttpError(404, "患者が見つかりません");
  const f = facility.results[0];
  if (!f) throw new Error(`調剤日 ${date} に効いている薬局の届出（pharmacy_facility）がありません`);
  return {
    date,
    facility: f,
    burdenPercent: p.burden_percent,
    ageYears: ageOn(p.birth_date, date),
    history: { within3Months: recent.results[0].n > 0, done: done.results.map((r) => r.code) },
    fees: Object.fromEntries(fees.results.map((r) => [r.code, { name: r.name, points: pointsOf(r) }])),
  };
}

// その日の点数を引く関数。マスターに無い（廃止された）項目を算定しようとしたら止める
export function feeLookup(fees, date) {
  return (code) => {
    const f = fees[code];
    if (!f) throw new Error(`調剤行為コード ${code} は ${date} の調剤行為マスターにありません`);
    return f;
  };
}

export function ageOn(birthDate, date) {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}
