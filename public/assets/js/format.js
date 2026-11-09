// 表示と入力の整形だけを置く。計算・規則はサーバーだけが持つ（src/rules/）。

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

// 分数の円を表示用に小数第2位まで（第3位を四捨五入）
export function formatYen({ num, den }) {
  const hundredths = (num * 100n * 2n + den) / (den * 2n);
  const s = hundredths.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

// 銭 → "36.90"
export function formatSen(sen) {
  return formatYen({ num: BigInt(sen), den: SEN_PER_YEN });
}

// 満年齢（on の日付時点）
export function ageOn(birthDate, on) {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}
