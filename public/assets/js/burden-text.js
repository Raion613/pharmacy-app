// 負担割合の表示だけを置く。割合の規則（年齢の境目・選べる割合・確認）はサーバーだけが持つ（src/rules/burden.js）。

export const BURDEN_REASONS = {
  disability: "65〜74歳の障害認定（後期高齢者医療）",
  exempt: "一部負担金の免除",
  welfare: "生活保護",
};

export function burdenText(percent, reason = null) {
  if (reason === "welfare") return "生活保護";
  if (reason === "exempt") return "免除";
  return `${percent / 10}割${reason === "disability" ? "（障害認定）" : ""}`;
}
export function burdenLongText(percent, reason = null) {
  if (reason === "welfare") return "生活保護（医療扶助・自己負担なし）";
  if (reason === "exempt") return "一部負担金の免除（自己負担なし）";
  return `${percent / 10}割${reason === "disability" ? "（65〜74歳の障害認定・後期高齢者医療）" : ""}`;
}

// その日の年齢（満年齢と月）
export function ageParts(birth, date) {
  const [by, bm, bd] = birth.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  let months = (y - by) * 12 + (m - bm) - (d < bd ? 1 : 0);
  if (months < 0) months = 0;
  return { years: Math.floor(months / 12), months: months % 12 };
}
