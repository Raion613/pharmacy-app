// 薬剤料の計算（内服薬のみ）。DB にも画面にも依存しない純粋関数だけを置く。
// ブラウザ（入力中のプレビュー）とサーバー（保存時の確定計算）が同じこのファイルを使う。
//
// 根拠：調剤報酬点数表 区分20 薬剤料
//   使用薬剤の薬価が所定単位につき15円以下の場合は1点。
//   15円を超える場合は、10円又はその端数を増すごとに1点を加算する。
//   内服薬の所定単位は「1剤1日分」。点数は1日分の点数 × 投与日数。
//
// 金額は小数で計算しない。double だと 15.000000001 のような誤差で境界の判定を誤るため、
//   薬価       … 銭（1/100円）の整数。医薬品マスターの金額は規格単位を最小単位（1錠・1g・1mL）にした金額
//   1日量      … 1/1000単位の整数（0.5錠 → 500）
// で受け取り、合計は BigInt の分数（分子 / 分母）のまま持って比較する。

export const QTY_SCALE = 1000; // 1日量は小数第3位まで
const SEN_PER_YEN = 100n;

// "1.5" → 1500。小数第3位までの正の数だけを受け付ける。
export function parseQuantity(text) {
  const s = String(text).trim();
  if (!/^\d{1,4}(\.\d{1,3})?$/.test(s)) {
    throw new RangeError(`1日量は小数第3位までの数で入力してください: "${text}"`);
  }
  const [int, frac = ""] = s.split(".");
  const milli = Number(int) * QTY_SCALE + Number(frac.padEnd(3, "0"));
  if (milli === 0) throw new RangeError("1日量は0より大きい数で入力してください");
  return milli;
}

// 1500 → "1.5"
export function formatQuantity(milli) {
  const int = Math.floor(milli / QTY_SCALE);
  const frac = String(milli % QTY_SCALE).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : String(int);
}

// 1剤1日分の薬価合計を分数で返す（単位：円）。
// items: [{ priceSen, dailyQtyMilli }]
export function dailyCost(items) {
  if (items.length === 0) throw new RangeError("1剤に薬が1つもありません");
  let num = 0n;
  for (const it of items) {
    if (!Number.isInteger(it.priceSen) || it.priceSen < 0) throw new RangeError(`薬価が不正です: ${it.priceSen}`);
    if (!Number.isInteger(it.dailyQtyMilli) || it.dailyQtyMilli <= 0) throw new RangeError(`1日量が不正です: ${it.dailyQtyMilli}`);
    num += BigInt(it.priceSen) * BigInt(it.dailyQtyMilli);
  }
  return { num, den: SEN_PER_YEN * BigInt(QTY_SCALE) };
}

// 1日分の薬価合計（分数・円）→ 1日分の点数
export function pointsPerDay({ num, den }) {
  if (num <= 15n * den) return 1;
  // 15円を超えた分を10円ごとに切り上げて加算： 1 + ceil((x - 15) / 10) = ceil((x - 5) / 10)
  return Number(ceilDiv(num - 5n * den, 10n * den));
}

// 1剤分の計算。days は投与日数（整数）。
export function calcRp({ items, days }) {
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`投与日数が不正です: ${days}`);
  const cost = dailyCost(items);
  const perDay = pointsPerDay(cost);
  return { cost, dailyYen: formatYen(cost), pointsPerDay: perDay, days, points: perDay * days };
}

// 処方全体。rps: [{ items, days }]
export function calcPrescription(rps) {
  const results = rps.map(calcRp);
  return { rps: results, totalPoints: results.reduce((sum, r) => sum + r.points, 0) };
}

// ---------- 長期収載品の選定療養：特別の料金 ----------
//
// 根拠：厚生労働省保険局医療課 事務連絡「長期収載品の処方等又は調剤に係る選定療養における費用の計算方法について」
//   （令和6年7月12日。令和8年3月27日・9月30日改正）
// 患者が希望して長期収載品（先発品）を受け取ると、薬剤料は「保険外併用療養費の算出に用いる価格」（医薬品マスターの
// 選定療養区分 2「（選）」のコードの金額）で計算し、別に「特別の料金」を患者から受け取る。
// 特別の料金の元になる「長期収載品と後発医薬品の価格差の1/2」（令和8年5月までは1/4）は、
// 対になるコード（区分 1）の金額 −（選）のコードの金額 で、diffSen として受け取る。
//
//   令和9年2月28日まで：剤（1剤1日分）ごとに「価格差 × 1日量」を合計して薬剤料と同じ規則で点数にし、
//                       日数を掛けて剤の点数を合計 → × 10円 →（1 + 消費税率）
//   令和9年3月1日から ：処方箋の対象薬の「価格差 × 投薬全量」を合計 → 10円未満なら10円、
//                       それ以外は5円未満の端数を切り捨て・5円以上を10円に切り上げ →（1 + 消費税率）
export const AMOUNT_METHOD_FROM = "2027-03-01";
export const CONSUMPTION_TAX_PERCENT = 10n;

// rps: [{ days, items: [{ diffSen, dailyQtyMilli }] }]（diffSen が null の薬は対象外）。対象の薬が無ければ null
export function specialFee(rps, dispensedOn) {
  const targets = rps
    .map((rp) => ({ days: rp.days, items: rp.items.filter((it) => it.diffSen !== null) }))
    .filter((rp) => rp.items.length > 0);
  if (targets.length === 0) return null;
  const costs = targets.map((rp) => ({ days: rp.days, cost: dailyCost(rp.items.map((it) => ({ priceSen: it.diffSen, dailyQtyMilli: it.dailyQtyMilli }))) }));

  if (dispensedOn < AMOUNT_METHOD_FROM) {
    const perRp = costs.map(({ days, cost }) => ({ pointsPerDay: pointsPerDay(cost), days }));
    const points = perRp.reduce((sum, r) => sum + r.pointsPerDay * r.days, 0);
    return { method: "points", rps: perRp.map((r) => ({ ...r, points: r.pointsPerDay * r.days })), points, beforeTaxYen: points * 10, yen: withTax(points * 10) };
  }
  // 投薬全量 = 1日量 × 日数。全部の剤を合計してから端数を処理する
  const den = costs[0].cost.den;
  const num = costs.reduce((sum, { days, cost }) => sum + cost.num * BigInt(days), 0n);
  return { method: "amount", totalYen: formatYen({ num, den }), beforeTaxYen: roundToTen(num, den), yen: withTax(roundToTen(num, den)) };
}

// 10円未満は10円。それ以外は1の位（端数）が5円未満なら切り捨て、5円以上なら10円に切り上げ
function roundToTen(num, den) {
  if (num < 10n * den) return 10;
  const tens = num / (10n * den);
  const rest = num - tens * 10n * den;
  return Number((rest < 5n * den ? tens : tens + 1n) * 10n);
}

// 10円単位の金額に消費税を加える（10円単位なので1円未満の端数は出ない）
function withTax(yen) {
  const total = BigInt(yen) * (100n + CONSUMPTION_TAX_PERCENT);
  if (total % 100n !== 0n) throw new RangeError(`消費税込みの額に1円未満の端数が出ます: ${yen}`);
  return Number(total / 100n);
}

// 分数の円を表示用に小数第2位まで（第3位を四捨五入）。点数の判定には使わない。
export function formatYen({ num, den }) {
  const hundredths = (num * 100n * 2n + den) / (den * 2n);
  const s = hundredths.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

// 銭 → "36.90"
export function formatSen(sen) {
  return formatYen({ num: BigInt(sen), den: SEN_PER_YEN });
}

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}
