// 領収証と明細書（調剤）。様式は「医療費の内容の分かる領収証及び個別の診療報酬の算定項目の分かる明細書の交付について」
// （令和8年3月5日 保発0305第18号）の別紙様式3（領収証・調剤報酬の例）に合わせる。明細書は算定した項目ごとの点数と回数
import { api, escapeHtml, formatDate, today } from "./app.js";
import { formatQuantity } from "./yakuzairyo.js";
import { burdenText, burdenLongText, WELFARE } from "./burden.js";

const id = new URLSearchParams(location.search).get("id");
const { patient, prescription: rx, pharmacy } = await api(`/api/prescriptions/${id}?purpose=receipt`);
document.title = `領収証・明細書 ${patient.name} ${rx.dispensedOn}`;

const SECTION = { tech: "調剤技術料", mgmt: "薬学管理料", other: "その他" };
const sum = (s) => rx.fees.filter((f) => f.section === s).reduce((t, f) => t + f.points * f.count, 0);
const special = rx.specialFeeYen ?? 0;
const tax = special - (special * 100) / 110; // 特別の料金は消費税込み（10円単位 × 1.1 なので割り切れる）
const unit = (u) => (u === "" ? "規格単位" : u);
const pt = (n) => `${n.toLocaleString()}<small>点</small>`;
const yen = (n) => `${n.toLocaleString()}<small>円</small>`;

document.querySelector("#sheet").innerHTML = `
  <section class="receipt">
    <h1>領　収　証</h1>
    <table class="r-head">
      <tr><th>患者番号</th><td>${escapeHtml(patient.patientNo)}</td><th>氏名</th><td class="name">${escapeHtml(patient.name)} 様</td>
          <th>調剤日</th><td>${formatDate(rx.dispensedOn)}</td></tr>
      <tr><th>領収証No.</th><td>${rx.id.slice(0, 8).toUpperCase()}</td><th>発行日</th><td>${formatDate(today())}</td>
          <th>負担割合</th><td>${burdenLongText(rx.burdenPercent)}</td></tr>
    </table>
    <table class="r-sections">
      <caption>保険（点）</caption>
      <tr><th>調剤技術料</th><th>薬学管理料</th><th>薬剤料</th><th>特定保険医療材料料</th><th>その他</th><th class="total">合計</th></tr>
      <tr><td>${pt(sum("tech"))}</td><td>${pt(sum("mgmt"))}</td><td>${pt(rx.drugPoints)}</td><td>${pt(0)}</td><td>${pt(sum("other"))}</td>
          <td class="total">${pt(rx.totalPoints)}</td></tr>
    </table>
    <table class="r-money">
      <tr><th>保険　負担額</th><td>${yen(rx.copayYen)}</td></tr>
      <tr><th>保険外負担　評価療養・選定療養</th><td>${yen(special)}</td></tr>
      ${special ? `<tr class="detail"><th>（内訳）長期収載品の選定療養に係る特別の料金</th><td>${yen(special)}（うち消費税 ${tax.toLocaleString()}円）</td></tr>` : ""}
      <tr><th>保険外負担　その他</th><td>${yen(0)}</td></tr>
      <tr class="grand"><th>領収額 合計</th><td>${yen(rx.copayYen + special)}</td></tr>
    </table>
    <p class="note">※厚生労働省が定める診療報酬や薬価等には、医療機関等が仕入れ時に負担する消費税が反映されています。</p>
    <footer class="issuer"><div>${escapeHtml(pharmacy.address)}<br><b>${escapeHtml(pharmacy.name)}</b><br>TEL ${escapeHtml(pharmacy.phone)}</div><div class="stamp">領収印</div></footer>
  </section>

  <section class="statement">
    <h1>調剤明細書</h1>
    <p class="meta">${escapeHtml(patient.name)} 様 ・ 患者番号 ${escapeHtml(patient.patientNo)} ・ 調剤日 ${formatDate(rx.dispensedOn)} ・ ${rx.burdenPercent === WELFARE ? "生活保護（医療扶助）" : `保険（${burdenText(rx.burdenPercent)}）`}</p>
    <table class="s-lines">
      <thead><tr><th>部</th><th>項目名</th><th class="num">点数</th><th class="num">回数</th></tr></thead>
      <tbody>
        ${["tech", "mgmt"].map((s) => rx.fees.filter((f) => f.section === s).map((f, i) => `
          <tr><td>${i === 0 ? SECTION[s] : ""}</td><td>＊${escapeHtml(f.name)}</td><td class="num">${f.points}</td><td class="num">${f.count}</td></tr>`).join("")).join("")}
        ${rx.rps.map((rp, i) => `
          <tr><td>${i === 0 ? "薬剤料" : ""}</td><td>＊Rp${rp.rpNo} ${escapeHtml(rp.usage)}
            ${rp.items.map((it) => `<div class="drug">${escapeHtml(it.name)}　${formatQuantity(it.dailyQtyMilli)}${escapeHtml(unit(it.unit))}</div>`).join("")}</td>
            <td class="num">${rp.pointsPerDay}</td><td class="num">${rp.days}</td></tr>`).join("")}
        ${rx.fees.filter((f) => f.section === "other").map((f, i) => `
          <tr><td>${i === 0 ? SECTION.other : ""}</td><td>＊${escapeHtml(f.name)}</td><td class="num">${f.points}</td><td class="num">${f.count}</td></tr>`).join("")}
      </tbody>
      <tfoot><tr><td></td><td>合計</td><td class="num" colspan="2">${rx.totalPoints.toLocaleString()}点</td></tr></tfoot>
    </table>
    ${special ? `<p class="meta">保険外：長期収載品の選定療養に係る特別の料金 ${special.toLocaleString()}円（消費税込み）</p>` : ""}
    <p class="note">※明細書には薬剤の名称が記載されます。※厚生労働省が定める診療報酬や薬価等には、医療機関等が仕入れ時に負担する消費税が反映されています。</p>
    <footer class="issuer"><div><b>${escapeHtml(pharmacy.name)}</b></div></footer>
  </section>`;

document.querySelector("#print").addEventListener("click", () => print());
