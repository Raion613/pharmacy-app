// 「この薬の、この日付時点の薬価」を引く。
//
// drug_prices にはマスターの変更年月日ごとに1行ずつ増える。ある日付 D の薬価は
// 「valid_from が D 以前の行のうち、いちばん新しい行」。サブクエリでその valid_from を求めて結合する。
// ?1 には日付を渡す。薬価が無い薬も候補に出すため LEFT JOIN にしている。
// 選定療養区分 2（（選）のコード）は、対になるコード（pp）の同じ日付の金額も引く。差が「価格差の1/2」（令和8年5月までは1/4）。
export const PRICE_AT_DATE_JOIN = `
  LEFT JOIN drug_prices p
         ON p.drug_code = d.code
        AND p.valid_from = (SELECT MAX(x.valid_from) FROM drug_prices x WHERE x.drug_code = d.code AND x.valid_from <= ?1)
  LEFT JOIN drug_prices pp
         ON pp.drug_code = d.pair_code
        AND pp.valid_from = (SELECT MAX(x.valid_from) FROM drug_prices x WHERE x.drug_code = d.pair_code AND x.valid_from <= ?1)`;

export const DRUG_COLUMNS = `
  d.code, d.yj_code, d.name, d.unit, d.generic, d.general_name, d.sentei, d.pair_code, d.narcotic,
  p.price_sen, p.valid_from, p.transitional_until, pp.price_sen AS pair_price_sen,
  (SELECT MIN(x.valid_from) FROM drug_prices x WHERE x.drug_code = d.code AND x.valid_from > ?1) AS next_from`;

// その日付に、その薬価で算定できるか
//   ok       … 使える
//   before   … その日付ではまだ収載されていない
//   ended    … 廃止された（price_sen が NULL の行）
//   expired  … 経過措置の使用期限を過ぎた
//   noPair   … 選定療養（患者希望）のコードだが、対になるコードの薬価がその日付に無い
export function priceStatus(row, date) {
  if (row.valid_from === null) return "before";
  if (row.price_sen === null) return "ended";
  if (row.transitional_until !== null && date > row.transitional_until) return "expired";
  if (row.sentei === 2 && row.pair_price_sen === null) return "noPair";
  return "ok";
}

export const STATUS_MESSAGE = {
  before: "この日付では、まだ薬価基準に収載されていません",
  ended: "この日付では、医薬品マスターで廃止されています",
  expired: "経過措置の使用期限を過ぎています",
  noPair: "選定療養の対になる薬の薬価が、この日付にありません",
};

export function toDrugJson(row, date) {
  const status = priceStatus(row, date);
  return {
    code: row.code,
    yjCode: row.yj_code,
    name: row.name,
    unit: row.unit,
    generic: row.generic === 1,
    generalName: row.general_name,
    sentei: row.sentei,
    pairCode: row.pair_code,
    narcotic: row.narcotic, // 1 麻薬 2 毒薬 3 覚醒剤原料 5 向精神薬（薬剤調製料の加算）
    priceSen: row.price_sen,
    validFrom: row.valid_from,
    transitionalUntil: row.transitional_until,
    nextChangeOn: row.next_from, // この日付より後で、次に薬価（または経過措置）が変わる日
    // 選定療養（患者希望）だけ：長期収載品と後発医薬品の価格差の1/2（銭）
    diffSen: row.sentei === 2 && status === "ok" ? row.pair_price_sen - row.price_sen : null,
    status,
  };
}

// 複数の薬コードについて、日付時点の薬価をまとめて引く。存在しないコードは Map に入らない。
export async function pricesAt(db, codes, date) {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await db
    .prepare(`SELECT ${DRUG_COLUMNS} FROM drugs d ${PRICE_AT_DATE_JOIN} WHERE d.code IN (${placeholders})`)
    .bind(date, ...unique)
    .all();
  return new Map(results.map((row) => [row.code, toDrugJson(row, date)]));
}
