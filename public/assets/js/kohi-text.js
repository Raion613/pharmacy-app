// 公費の表示だけを置く。窓口の額の計算はサーバーだけが持つ（src/rules/kohi.js）。

export const KOHI_KINDS = {
  mental: { law: "21", label: "自立支援医療（精神通院）", short: "精神通院", rate: 10 },
  childchronic: { law: "52", label: "小児慢性特定疾病", short: "小児慢性", rate: 20 },
  nanbyo: { law: "54", label: "指定難病", short: "難病", rate: 20 },
  local: { law: null, label: "自治体の助成", short: "自治体", rate: null },
};
// 自治体の助成の、薬局での負担の形
export const LOCAL_FORMS = { free: "無料", perVisit: "1回いくら", cap: "月の上限まで" };

export const isNational = (kind) => kind !== "local";

// 公費の表示名（自治体の助成は名前を付ける。例：子ども医療費助成（上田市））
export const kohiName = (k) => (k.kind === "local" ? k.localName : KOHI_KINDS[k.kind].label);

// その日に使える公費か
export const kohiValidOn = (k, date) => k.validFrom <= date && date <= k.validUntil;

// 月の上限で管理する公費か（管理票に書く）
export const hasMonthlyCap = (k) => k.capYen !== null && (isNational(k.kind) || k.localForm === "cap");

// 帯に出す短い表示（その日に有効な公費の短い名前。無ければ「なし」）
export function kohiBandText(kohi, date) {
  const valid = kohi.filter((k) => kohiValidOn(k, date));
  return valid.length ? valid.map((k) => (k.kind === "local" ? k.localName : KOHI_KINDS[k.kind].short)).join("・") : "なし";
}

const yen = (v) => `${v.toLocaleString()}円`;
// 公費の患者の負担の形（例：1割・月 5,000円 まで／無料／1回 200円）
export function kohiBurdenText(k) {
  if (isNational(k.kind)) return `${KOHI_KINDS[k.kind].rate / 10}割・${k.capYen === null ? "上限なし" : `月 ${yen(k.capYen)} まで`}`;
  return k.localForm === "free" ? "無料" : k.localForm === "perVisit" ? `1回 ${yen(k.perVisitYen)}` : `月 ${yen(k.capYen)} まで`;
}
