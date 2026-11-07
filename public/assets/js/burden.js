// 負担割合（一部負担金の割合）の規則。画面とサーバーで共通に使う。
// 割合は保険証（マイナ保険証の資格確認）に書かれたものを使う。年齢で「ありうる割合」が決まり、70歳以上は所得でその中のどれかになる。
//   小学校に上がる前（6歳に達した日以後の最初の3月31日まで） 2割                         健康保険法 74条1項
//   それ以降、70歳になるまで                                   3割
//   70〜74歳（70歳に達した日の翌月1日から。達した日が1日ならその月から） 2割、現役並み所得は3割   高齢受給者
//   75歳以上（75歳の誕生日から）                               1割、一定以上所得は2割、現役並み所得は3割   後期高齢者医療
//   生活保護                                                   自己負担なし（健康保険から外れ、医療扶助で払う）
// 「〇歳に達した日」は誕生日の前日（年齢計算ニ関スル法律）。4月1日生まれが早生まれになるのはこのため。
// 70歳以上の割合は、毎年8月1日に前の年の所得で見直される。

export const WELFARE = 0;
export const BURDENS = [30, 20, 10, WELFARE];
export const burdenText = (p) => (p === WELFARE ? "生活保護" : `${p / 10}割`);
export const burdenLongText = (p) => (p === WELFARE ? "生活保護（医療扶助・自己負担なし）" : `${p / 10}割`);

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
    school: `${schoolYear}-04-01`,                                                                // 小学校に上がる年の4月1日
    elder: ed === 1 ? iso(Date.UTC(ey, em - 1, 1)) : iso(Date.UTC(ey, em, 1)),                  // 高齢受給者になる日
    late: birthday(birth, 75),                                                                    // 後期高齢者になる日
  };
}

// その日にありうる割合（生活保護は年齢によらず、いつでもありうる）
export function allowedBurdens(birth, date) {
  const b = burdenBoundaries(birth);
  const insured = date < b.school ? [20] : date < b.elder ? [30] : date < b.late ? [20, 30] : [10, 20, 30];
  return [...insured, WELFARE];
}

// その日の年齢（満年齢と月）
export function ageParts(birth, date) {
  const [by, bm, bd] = parts(birth);
  const [y, m, d] = parts(date);
  let months = (y - by) * 12 + (m - bm) - (d < bd ? 1 : 0);
  if (months < 0) months = 0;
  return { years: Math.floor(months / 12), months: months % 12 };
}

// from（前回の来局）より後、to（今回）までに、割合が変わりうる出来事。古い順
export function burdenEvents(birth, from, to) {
  const b = burdenBoundaries(birth);
  const events = [
    { on: b.school, text: "小学校に上がる年の4月1日を過ぎました。2割から3割になります" },
    { on: b.elder, text: "70歳になった翌月の1日を過ぎました（高齢受給者）。3割から2割になります（現役並みの所得なら3割のまま）" },
    { on: b.late, text: "75歳の誕生日を過ぎました（後期高齢者医療）。1割になります（所得によって2割・3割）" },
  ];
  // 70歳以上は、毎年8月1日に所得で割合が見直される
  const [fy] = parts(from);
  const [ty] = parts(to);
  for (let y = fy; y <= ty; y++) {
    const aug = `${y}-08-01`;
    if (aug >= b.elder) events.push({ on: aug, text: `${y}年8月1日を過ぎました。前の年の所得で割合が見直されています` });
  }
  return events.filter((e) => e.on > from && e.on <= to).sort((a, b2) => (a.on < b2.on ? -1 : 1));
}
