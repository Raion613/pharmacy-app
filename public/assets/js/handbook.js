// お薬手帳：紙の手帳に貼る内容（シール）と、電子版お薬手帳に読み込ませる QR コード（JAHIS 形式）。
// どちらも同じ処方（調剤した薬・量・用法・日数）から作る。処方箋の記載ではなく、実際に渡した内容を書く
import { api, escapeHtml, formatDate } from "./app.js";
import { formatQuantity } from "./yakuzairyo.js";
import { jahisText, toShiftJis } from "./okusuri-techo.js";
import { encodeQr, qrSvg } from "./qr.js";

const id = new URLSearchParams(location.search).get("id");
const { patient, prescription: rx, pharmacy } = await api(`/api/prescriptions/${id}?purpose=handbook`);
document.title = `お薬手帳 ${patient.name} ${rx.dispensedOn}`;

const text = jahisText({ patient, pharmacy, prescription: rx });
const bytes = toShiftJis(text);
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
      <div class="qr">${qrSvg(encodeQr(bytes), 3)}</div>
      <p>電子版お薬手帳のアプリで読み取れます</p>
      <p class="hint">JAHIS 電子版お薬手帳データフォーマット Ver.2.0（JAHISTC03）・Shift_JIS ${bytes.length.toLocaleString()}バイト</p>
      <details class="raw"><summary>QR コードの中身</summary><pre>${escapeHtml(text)}</pre></details>
    </div>
  </section>`;

document.querySelector("#print").addEventListener("click", () => print());
