// お薬手帳：紙の手帳に貼る内容（シール）と、電子版お薬手帳に読み込ませる QR コード（JAHIS 形式）。
// どちらも同じ処方（調剤した薬・量・用法・日数）から作る。処方箋の記載ではなく、実際に渡した内容を書く
import { api, escapeHtml, formatDate } from "./app.js";
import { formatQuantity } from "./format.js";
import { encodeQr, qrSvg } from "./qr.js";

// 画面を開くたびに router.js が呼ぶ（画面は中身だけを差し替えるので、画面の処理はこの関数の中に置く）
export default async function mount() {
  const id = new URLSearchParams(location.search).get("id");
  const { patient, prescription: rx, pharmacy, handbook } = await api(`/api/prescriptions/${id}?purpose=handbook`);
  document.title = `お薬手帳 ${patient.name} ${rx.dispensedOn}`;

  // 電子版お薬手帳のデータ（JAHIS 形式・Shift_JIS）はサーバーが作る
  // 1つの QR コードに入らないときは、サーバーが仕様書の決まりで分けてくる。分けた数だけ並べる
  const qrs = handbook.parts.map((p) => qrSvg(encodeQr(Uint8Array.from(atob(p.sjisBase64), (c) => c.charCodeAt(0))), 3));
  const unit = (u) => (u === "" ? "規格単位" : u);

  document.querySelector("#sheet").innerHTML = `
  <section class="techo">
    <div class="sticker">
      <header><b>${formatDate(rx.dispensedOn)}</b><span>${escapeHtml(patient.name)} 様</span></header>
      ${rx.rps.map((rp) => `
        <div class="t-rp">
          ${rp.items.map((it) => `<div class="t-drug"><span>${escapeHtml(it.name)}</span><span class="num">${formatQuantity(it.dailyQtyMilli)}${escapeHtml(unit(it.unit))}</span></div>`).join("")}
          <div class="t-usage">【${escapeHtml(rp.usage)}】 ${rp.days}日分</div>
        </div>`).join("")}
      <footer>${escapeHtml(pharmacy.name)}　TEL ${escapeHtml(pharmacy.phone)}<br>薬剤師 ${escapeHtml(rx.createdBy)}</footer>
    </div>
    <div class="qr-block">
      ${qrs.map((svg, i) => `<div class="qr">${qrs.length > 1 ? `<span class="qr-no">${i + 1} / ${qrs.length}</span>` : ""}${svg}</div>`).join("")}
      <p>電子版お薬手帳のアプリで読み取れます${qrs.length > 1 ? `（${qrs.length}つに分けています。全部読み取ってください）` : ""}</p>
    </div>
    <details class="raw" open><summary>QR コードの中身</summary><pre>${escapeHtml(handbook.parts.map((p) => p.text).join("\n"))}</pre></details>
  </section>`;

  document.querySelector("#print").addEventListener("click", () => print());
}
