// 負担割合（一部負担金の割合）の規則。サーバーだけが持つ（表示は public/assets/js/burden-text.js）。
// 割合は保険証（マイナ保険証の資格確認）に書かれたものを使う。年齢で標準が決まり、所得や事情でそれ以外になることがある。
//   年齢の標準（理由なし）
//     小学校に上がる前（6歳に達した日以後の最初の3月31日まで） 2割                          健康保険法 74条1項
//     それ以降、70歳になるまで                                   3割
//     70〜74歳（70歳に達した日の翌月1日から。達した日が1日ならその月から） 2割、現役並み所得は3割    高齢受給者
//     75歳以上（75歳の誕生日から）                               1割、一定以上所得は2割、現役並み所得は3割    後期高齢者医療
//   標準から外れる事情（理由を持つ）
//     disability：65〜74歳で一定の障害があり、広域連合の認定を受けた人。後期高齢者医療に入り 1・2・3割（高齢者医療確保法）
//     exempt    ：一部負担金の免除（災害・急な収入の減少などで保険者が認めたとき。国民健康保険法44条）。0。期限がある
//     welfare   ：生活保護。健康保険から外れ、医療扶助で払う。0
// 「〇歳に達した日」は誕生日の前日（年齢計算ニ関スル法律）。4月1日生まれが早生まれになるのはこのため。
// 70歳以上の割合は、毎年8月1日に前の年の所得で見直される。

import { BURDEN_REASONS, burdenText, burdenLongText, ageParts } from "../../public/assets/js/burden-text.js";

export { BURDEN_REASONS, burdenText, burdenLongText, ageParts };

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const parts = (date) => date.split("-").map(Number);

// n 歳の誕生日（2月29日生まれは、うるう年でない年は3月1日）
function birthday(birth, n) {
  const [y, m, d] = parts(birth);
  return iso(Date.UTC(y + n, m - 1, d));
}
// n 歳に達した日（誕生日の前日）
function reached(birth, n) {
  const [y, m, d] = parts(birth);
  return iso(Date.UTC(y + n, m - 1, d - 1));
}

// 年齢で割合が変わる日
export function burdenBoundaries(birth) {
  const six = reached(birth, 6);
  const [sy] = parts(six);
  const schoolYear = six <= `${sy}-03-31` ? sy : sy + 1; // 6歳に達した日以後の最初の3月31日の年
  const [ey, em, ed] = parts(reached(birth, 70));
  return {
    school: `${schoolYear}-04-01`,                                                // 小学校に上がる年の4月1日
    sixtyFive: reached(birth, 65),                                                // 障害認定で後期高齢者医療に入れる日
    elder: ed === 1 ? iso(Date.UTC(ey, em - 1, 1)) : iso(Date.UTC(ey, em, 1)),  // 高齢受給者になる日
    late: birthday(birth, 75),                                                    // 後期高齢者になる日
  };
}

// 年齢の標準でありうる割合
export function standardBurdens(birth, date) {
  const b = burdenBoundaries(birth);
  return date < b.school ? [20] : date < b.elder ? [30] : date < b.late ? [20, 30] : [10, 20, 30];
}

// その日に選べる割合と理由の組。年齢の標準 → 障害認定（65〜74歳のときだけ）→ 免除 → 生活保護
export function burdenChoices(birth, date) {
  const b = burdenBoundaries(birth);
  const list = standardBurdens(birth, date).map((percent) => ({ percent, reason: null }));
  if (date >= b.sixtyFive && date < b.late) list.push(...[10, 20, 30].map((percent) => ({ percent, reason: "disability" })));
  list.push({ percent: 0, reason: "exempt" }, { percent: 0, reason: "welfare" });
  return list;
}

// 患者の今の割合が、その日に正しくありうるか。ありえなければ理由の文、ありうれば null
//   p：{ birthDate, burdenPercent, burdenReason, burdenUntil }
export function burdenProblem(p, date) {
  if (p.burdenReason === "exempt" && (p.burdenUntil === null || p.burdenUntil < date)) {
    return `一部負担金の免除の期限（${p.burdenUntil ?? "未入力"}）を過ぎています`;
  }
  if (burdenChoices(p.birthDate, date).some((c) => c.percent === p.burdenPercent && c.reason === p.burdenReason)) return null;
  const age = ageParts(p.birthDate, date);
  const std = standardBurdens(p.birthDate, date).map((x) => `${x / 10}割`).join("・");
  return p.burdenReason === "disability"
    ? `${date}時点で${age.years}歳です。障害認定（後期高齢者医療）は65〜74歳の人の区分です（75歳からは年齢の区分）`
    : `${date}時点で${age.years}歳${age.months}か月の人の標準は ${std} で、${burdenText(p.burdenPercent, p.burdenReason)}は標準から外れます。事情があれば理由を選んでください`;
}

// from（前回の来局か、前回確かめた日）より後、to（今回）までに、割合が変わりうる出来事。古い順
//   p：{ birthDate, burdenReason, burdenUntil }
export function burdenEvents(p, from, to) {
  if (p.burdenReason === "welfare") return []; // 生活保護は年齢で変わらない
  const b = burdenBoundaries(p.birthDate);
  const events = [];
  if (p.burdenReason === "exempt") {
    events.push({ on: iso(Date.parse(p.burdenUntil) + 86400000), text: `一部負担金の免除の期限（${p.burdenUntil}）を過ぎました。保険証の割合に戻ります` });
  } else {
    if (p.burdenReason !== "disability") {
      events.push(
        { on: b.school, text: "小学校に上がる年の4月1日を過ぎました。2割から3割になります" },
        { on: b.elder, text: "70歳になった翌月の1日を過ぎました（高齢受給者）。3割から2割になります（現役並みの所得なら3割のまま）" },
      );
    }
    events.push({ on: b.late, text: "75歳の誕生日を過ぎました（後期高齢者医療）。1割になります（所得によって2割・3割）" });
    // 70歳以上（障害認定は65歳以上）は、毎年8月1日に所得で割合が見直される
    const from70 = p.burdenReason === "disability" ? b.sixtyFive : b.elder;
    const [fy] = parts(from);
    const [ty] = parts(to);
    for (let y = fy; y <= ty; y++) {
      const aug = `${y}-08-01`;
      if (aug >= from70) events.push({ on: aug, text: `${y}年8月1日を過ぎました。前の年の所得で割合が見直されています` });
    }
  }
  return events.filter((e) => e.on > from && e.on <= to).sort((a, b2) => (a.on < b2.on ? -1 : 1));
}
