// 在宅の訪問回数の決まり（在宅患者訪問薬剤管理指導料。調剤報酬点数表 区分15 と、その通知）。
//   ・患者1人につき月4回まで（末期の悪性腫瘍・注射による麻薬の投与・中心静脈栄養法の患者は週2回かつ月8回まで）
//   ・月2回以上算定するときは週1回まで（上の患者を除く）→ 結果として、通常の患者は同じ週に2回入れられない
//   ・保険薬剤師1人につき週40回まで
// 週は日曜〜土曜で数える（暦週）。月は暦月。
// 予定を入れる前に、この決まりに合うかを確かめる。合わなければ理由を返す（予定は入れない）。

export const PHARMACIST_WEEKLY_LIMIT = 40;

export function limitsFor(intensive) {
  return intensive ? { perMonth: 8, perWeek: 2 } : { perMonth: 4, perWeek: 1 };
}

// 'YYYY-MM-DD' の週の始め（日曜日）
export function weekStart(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

// patientDates：その患者の予定の日付、pharmacistDates：担当薬剤師の（全患者の）予定の日付
// 返す：理由の配列（空なら入れてよい）
export function checkVisit({ date, intensive, patientDates, pharmacistDates }) {
  const { perMonth, perWeek } = limitsFor(intensive);
  const reasons = [];
  if (patientDates.includes(date)) reasons.push("同じ日に予定があります");
  const month = date.slice(0, 7);
  const inMonth = patientDates.filter((d) => d.slice(0, 7) === month).length;
  if (inMonth >= perMonth) reasons.push(`この患者は${month.replace("-", "年")}月にもう${inMonth}回の予定があります（月${perMonth}回まで）`);
  const week = weekStart(date);
  const inWeek = patientDates.filter((d) => weekStart(d) === week).length;
  if (inWeek >= perWeek) reasons.push(`この患者は同じ週（${week} からの週）にもう${inWeek}回の予定があります（週${perWeek}回まで）`);
  const pharmacistWeek = pharmacistDates.filter((d) => weekStart(d) === week).length;
  if (pharmacistWeek >= PHARMACIST_WEEKLY_LIMIT) reasons.push(`担当の薬剤師はこの週にもう${pharmacistWeek}回の訪問があります（1人週${PHARMACIST_WEEKLY_LIMIT}回まで）`);
  return reasons;
}

// 計画書の見直しの目安（通知：少なくとも月1回見直す）。作った日の1か月後の同じ日（その日が無い月は月末）
export function planReviewDue(madeOn) {
  const [y, m, d] = madeOn.split("-").map(Number);
  const lastOfNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastOfNext))).toISOString().slice(0, 10);
}

// 訪問の記録と、その日までの最新の指導記録から、処方医への報告書の本文を組み立てる。
// kusudamaクラウド薬歴では AI が薬歴の内容を報告書の形式にまとめる所を、ここでは決まった形に並べる。
export function composeReport({ visit, record }) {
  const lines = [
    `【服薬状況】${visit.adherence}`,
    `【残薬】${visit.leftover}`,
    `【保管状況】${visit.storage}`,
    `【実施した指導】${visit.guidance}`,
  ];
  if (record) {
    if (record.subjective) lines.push(`【患者・家族の訴え】${record.subjective}`);
    if (record.assessment) lines.push(`【薬剤師の評価】${record.assessment}`);
    if (record.plan) lines.push(`【今後の方針・提案】${record.plan}`);
  }
  return lines.join("\n");
}
