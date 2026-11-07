// 調剤報酬の算定（内服薬の外来調剤）。DB にも画面にも依存しない。ブラウザ（入力中の表示）とサーバー（保存時の確定）が同じこれを使う。
//
// 何を算定するか（どの調剤行為コードか）は、調剤日の点数表の規則でここが決める。
// 点数そのものは、支払基金の調剤行為マスターの「その日に効いている点数」を引数 fee(code) で受け取る（ここには書かない）。
//
// 根拠
//   令和6年度：調剤報酬点数表（平成20年厚生労働省告示第59号 別表第三。令和6年告示第57号で改正、
//              令和6年12月・令和7年4月の改正を含む）… 調剤日 2025-04-01 〜 2026-05-31
//   令和8年度：同（令和8年厚生労働省告示第69号で改正）、留意事項通知（令和8年3月5日 保医発0305第6号）… 2026-06-01 〜
//
// 扱わないもの（算定しない）：時間外・休日・深夜・夜間休日等加算、かかりつけ薬剤師、在宅、分割調剤、自家製剤・計量混合、
//   一包化（外来服薬支援料）、麻薬管理指導加算・特定薬剤管理指導加算（ハイリスク薬）、調剤管理加算（令和6年度）、
//   特別調剤基本料、減算（妥結率・後発医薬品・門前薬局等立地依存）、複数の処方箋の同時受付。README の「やっていないこと」
export const RULES_FROM = "2025-04-01";
const R8_FROM = "2026-06-01";
const MAX_RPS = 3; // 薬剤調製料・調剤管理料は「4剤分以上の部分については算定しない」

// 調剤行為コード（調剤行為マスター）
const CODE = {
  basic: { 1: "410004110", 2: "410004210", "3i": "410005510", "3ro": "410005610", "3ha": "410005710" },
  communityR6: { 1: "410002770", 2: "410002870", 3: "410002970", 4: "410003070" },      // 地域支援体制加算
  communityR8: { 1: "450004070", 2: "450004970", 3: "450004670", 4: "450004570", 5: "450004870" }, // 地域支援・医薬品供給対応体制加算
  renkei: "410003370",
  genericSystem: { 1: "450000370", 2: "450000970", 3: "450001470" },                   // 後発医薬品調剤体制加算（令和6年度）
  iryoDx: { 1: "450003370", 2: "450003470", 3: "450003270" },                           // 医療ＤＸ推進体制整備加算（令和6年度・月1回）
  denshiRenkei: "450003970",                                                            // 電子的調剤情報連携体制整備加算（令和8年度・月1回）
  naifukuChosei: "420001810",                                                           // 内服薬薬剤調製料（1剤につき）
  narcotic: { 1: "430000270", 5: "430000370", 3: "430000470", 2: "430000570" },        // 麻薬・向精神薬・覚醒剤原料・毒薬加算
  kanriR6: [[7, "440011510"], [14, "440011610"], [28, "440011710"], [Infinity, "440011810"]], // 内服薬調剤管理料（日数で区分）
  kanriR8Long: "440023210",                                                             // 調剤管理料１イ（28日分以上）
  kanriR8: "440023110",                                                                 // 調剤管理料１ロ
  jufukuR6: { adverse: "440011470", leftover: "440011570" },                            // 重複投薬・相互作用等防止加算
  zanyakuR8: "440023870",                                                               // 調剤時残薬調整加算ニ
  yugaiR8: "440024670",                                                                 // 薬学的有害事象等防止加算ニ
  iryoJoho: "440017870",                                                                // 医療情報取得加算（令和6年度・12月に1回）
  shidoR6: { handbook: "440012010", noHandbook: "440012110", other: "440012210" },      // 服薬管理指導料
  shidoR8: { handbook: "440025310", noHandbook: "440025410", other: "440026810" },      // 服薬管理指導料１ロ／２ロ
  nyuyoji: "440012270",                                                                 // 乳幼児服薬指導加算（6歳未満）
  baseUp: "470000010",                                                                  // 調剤ベースアップ評価料（令和8年度）
  bukka: "470000210",                                                                   // 調剤物価対応料（令和8年度・3月に1回）
};

// 履歴で回数を数える項目（同じ患者で、この期間にもう算定していれば今回は算定しない）
export const LIMITED = {
  month: [...Object.values(CODE.iryoDx), CODE.denshiRenkei], // 月1回
  months12: [CODE.iryoJoho],                                  // 12月に1回
  months3: [CODE.bukka],                                      // 3月に1回
};

export function eraOf(date) {
  if (date < RULES_FROM) throw new RangeError(`調剤日 ${date} の算定の規則は扱っていません（${RULES_FROM} 以降）`);
  return date < R8_FROM ? "r6" : "r8";
}

// 入力
//   date      … 調剤日
//   facility  … 届出（pharmacy_facility の1行）
//   ageYears  … 調剤日の年齢
//   handbook  … お薬手帳の提示 'paper' | 'electronic' | 'none'
//   history   … { within3Months：3月以内の再来局か, done: Set（期間内に算定済みのコード） }
//   rps       … [{ days, rxDays, daysChange, narcotics: [各薬の narcotic] }]
//   inquiries … [{ kind: 'leftover' | 'adverse', changed, shortReason }]
//   fee(code) … その日の点数 { name, points }（廃止なら例外）
// 出力 { lines: [{ section, code, name, points, count }], tech, mgmt, other }（点数の合計は区分ごと）
export function calcFees({ date, facility, ageYears, handbook, history, rps, inquiries, fee }) {
  const era = eraOf(date);
  const lines = [];
  const add = (section, code, count = 1) => {
    const f = fee(code);
    lines.push({ section, code, name: f.name, points: f.points, count });
  };
  const notDone = (code) => !history.done.has(code);

  // ---- 調剤技術料：調剤基本料と加算（処方箋の受付1回につき） ----
  add("tech", CODE.basic[facility.basic_fee]);
  if (era === "r6") {
    if (facility.community_support) add("tech", CODE.communityR6[facility.community_support]);
    if (facility.renkei) add("tech", CODE.renkei);
    if (facility.generic_system) add("tech", CODE.genericSystem[facility.generic_system]);
    if (facility.iryo_dx && notDone(CODE.iryoDx[facility.iryo_dx])) add("tech", CODE.iryoDx[facility.iryo_dx]);
  } else {
    if (facility.community_support) add("tech", CODE.communityR8[facility.community_support]);
    if (facility.renkei) add("tech", CODE.renkei);
    if (facility.denshi_renkei && notDone(CODE.denshiRenkei)) add("tech", CODE.denshiRenkei);
  }

  // ---- 調剤技術料：薬剤調製料（1剤につき、3剤まで）と、麻薬・向精神薬・覚醒剤原料・毒薬加算（1調剤につき） ----
  // 4剤以上のときは、調剤管理料の点数が高い（日数が長い）剤から3剤を数える
  const counted = [...rps].sort((a, b) => b.days - a.days).slice(0, MAX_RPS);
  add("tech", CODE.naifukuChosei, counted.length);
  const narcoticCounts = new Map();
  for (const rp of counted) {
    // 1剤に複数あれば、麻薬（70点）を優先し、その他（8点）は1つだけ
    const kind = [1, 5, 3, 2].find((k) => rp.narcotics.includes(k));
    if (kind) narcoticCounts.set(kind, (narcoticCounts.get(kind) ?? 0) + 1);
  }
  for (const [kind, n] of narcoticCounts) add("tech", CODE.narcotic[kind], n);

  // ---- 薬学管理料：調剤管理料（内服薬1剤につき、3剤まで） ----
  if (era === "r6") {
    const byCode = new Map();
    for (const rp of counted) {
      const code = CODE.kanriR6.find(([max]) => rp.days <= max)[1];
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    for (const [code, n] of byCode) add("mgmt", code, n);
  } else {
    const long = counted.filter((rp) => rp.days >= 28).length;
    if (long) add("mgmt", CODE.kanriR8Long, long);
    if (counted.length - long) add("mgmt", CODE.kanriR8, counted.length - long);
  }

  // ---- 薬学管理料：処方医への照会で処方が変わった場合の加算（処方箋の受付1回につき1回） ----
  const changed = (kind) => inquiries.some((q) => q.kind === kind && q.changed);
  if (era === "r6") {
    // 重複投薬・相互作用等防止加算：残薬調整以外 40点／残薬調整 20点。両方あれば高い方
    if (changed("adverse")) add("mgmt", CODE.jufukuR6.adverse);
    else if (changed("leftover")) add("mgmt", CODE.jufukuR6.leftover);
  } else {
    // 調剤時残薬調整加算：照会（または処方箋の減数調剤の指示）で7日分以上減らした場合。6日分以下は理由を明細書に書く場合だけ
    const reduced = Math.max(0, ...rps.filter((rp) => rp.daysChange !== null).map((rp) => rp.rxDays - rp.days));
    const leftoverChanged = changed("leftover") || rps.some((rp) => rp.daysChange === "instruction");
    const shortReason = inquiries.some((q) => q.kind === "leftover" && q.changed && q.shortReason);
    if (leftoverChanged && (reduced >= 7 || (reduced > 0 && shortReason))) add("mgmt", CODE.zanyakuR8);
    if (changed("adverse")) add("mgmt", CODE.yugaiR8);
  }
  if (era === "r6" && facility.iryo_joho && notDone(CODE.iryoJoho)) add("mgmt", CODE.iryoJoho);

  // ---- 薬学管理料：服薬管理指導料（3月以内の再来局で手帳を提示 → 1、それ以外 → 2） ----
  const shido = era === "r6" ? CODE.shidoR6 : CODE.shidoR8;
  if (!history.within3Months) add("mgmt", shido.other);
  else add("mgmt", handbook === "none" ? shido.noHandbook : shido.handbook);
  // 乳幼児服薬指導加算：6歳未満で、指導の内容を手帳に記載した場合
  if (ageYears < 6 && handbook !== "none") add("mgmt", CODE.nyuyoji);

  // ---- その他（令和8年度の第5節） ----
  if (era === "r8") {
    if (facility.base_up) add("other", CODE.baseUp);
    if (notDone(CODE.bukka)) add("other", CODE.bukka);
  }

  const sum = (section) => lines.filter((l) => l.section === section).reduce((s, l) => s + l.points * l.count, 0);
  return { era, lines, tech: sum("tech"), mgmt: sum("mgmt"), other: sum("other") };
}

// 一部負担金：合計点数 × 10円 × 負担割合。10円未満は四捨五入（健康保険法第75条）。生活保護（0）は0円
export function copayYen(totalPoints, burdenPercent) {
  if (![0, 10, 20, 30].includes(burdenPercent)) throw new RangeError(`負担割合が不正です: ${burdenPercent}`);
  const yen = (totalPoints * burdenPercent) / 10; // 点数 × 10円 × (割合/100)。割合が10%単位なので必ず整数
  return Math.floor((yen + 5) / 10) * 10;
}

// 調剤行為マスターの点数（100倍の整数）を点に。ここで扱う項目は全部「点数（プラス）」で整数点
export function pointsOf(row) {
  if (row.point_kind !== "3" || row.points_x100 % 100 !== 0) throw new RangeError(`点数として扱えない算定項目です: ${row.code}`);
  return row.points_x100 / 100;
}

export const ALL_CODES = [
  ...Object.values(CODE.basic), ...Object.values(CODE.communityR6), ...Object.values(CODE.communityR8), CODE.renkei,
  ...Object.values(CODE.genericSystem), ...Object.values(CODE.iryoDx), CODE.denshiRenkei, CODE.naifukuChosei,
  ...Object.values(CODE.narcotic), ...CODE.kanriR6.map(([, c]) => c), CODE.kanriR8Long, CODE.kanriR8,
  ...Object.values(CODE.jufukuR6), CODE.zanyakuR8, CODE.yugaiR8, CODE.iryoJoho, ...Object.values(CODE.shidoR6),
  ...Object.values(CODE.shidoR8), CODE.nyuyoji, CODE.baseUp, CODE.bukka,
];
