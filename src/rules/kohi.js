// 公費（公費負担医療・自治体の医療費助成）。窓口の額の計算はサーバーだけが持つ（表示は public/assets/js/kohi-text.js）。
// 患者が見せる受給者証には、公費負担者番号（先頭2桁が法別番号）・受給者番号・有効期間・自己負担の上限月額が書いてある。
// 保険の一部負担金のうえで、さらに患者の負担を減らす。国の公費を先にかけ、自治体の助成を後にかける。
//   自立支援医療（精神通院） 法別21：医療費の1割。月の上限（0・2,500・5,000・10,000・20,000円、または上限なし）
//   小児慢性特定疾病         法別52：2割（保険の割合がそれより低ければ保険の割合）。月の上限
//   指定難病                 法別54：2割（同上）。月の上限
//   自治体の助成（子ども・ひとり親・重度心身障害者）：自治体ごとに、無料／1回いくら／月の上限まで
// 月の上限は「自己負担上限額管理票」で管理する。薬局は来局のたびに医療費総額と自己負担額を書き込み、月の累計が上限に達したら取らない。
// 公費の分の端数の扱いは一次資料で確かめられていないので、一部負担金と同じく10円未満を四捨五入する。
// 生活保護（法別12）は、負担割合 0（burden.js の welfare）として扱う。

import { KOHI_KINDS, LOCAL_FORMS, isNational, kohiName, kohiValidOn, hasMonthlyCap, kohiBandText, kohiBurdenText } from "../../public/assets/js/kohi-text.js";

export { KOHI_KINDS, LOCAL_FORMS, isNational, kohiName, kohiValidOn, hasMonthlyCap, kohiBandText, kohiBurdenText };
const round10 = (yen) => Math.floor((yen + 5) / 10) * 10;

// 窓口の額を、公費を順にかけて出す。
//   totalPoints：合計点数、burdenPercent：保険の負担割合、copayYen：保険の一部負担金
//   kohi：[{ id, kind, capYen, localForm, perVisitYen, priorMonthYen }]（priorMonthYen は管理票のこの来局より前の今月の累計）
// 返す：{ steps: [{ id, payYen, monthTotalYen }], patientPayYen }。steps は国 → 自治体の順。payYen はその公費をかけた後の患者の負担
export function applyKohi({ totalPoints, burdenPercent, copayYen, kohi }) {
  const ordered = [...kohi].sort((a, b) => Number(isNational(b.kind)) - Number(isNational(a.kind)));
  let pay = copayYen;
  const steps = ordered.map((k) => {
    if (isNational(k.kind)) {
      const rate = Math.min(KOHI_KINDS[k.kind].rate, burdenPercent);
      pay = Math.min(pay, round10((totalPoints * 10 * rate) / 100));
    } else if (k.localForm === "free") {
      pay = 0;
    } else if (k.localForm === "perVisit") {
      pay = Math.min(pay, k.perVisitYen);
    }
    if (hasMonthlyCap(k)) pay = Math.min(pay, Math.max(0, k.capYen - k.priorMonthYen));
    return { id: k.id, payYen: pay, monthTotalYen: hasMonthlyCap(k) ? k.priorMonthYen + pay : null };
  });
  return { steps, patientPayYen: pay };
}

