// 調剤監査：処方の薬を棚から取り出したら、箱のバーコードを読んで、処方と同じ薬かを確かめる。
// 読み取り機（USB・Bluetooth）はキーボードとして文字と Enter を送ってくるので、入力欄で Enter を受けたら照合する。
// 照合はサーバーで行う（バーコードの GTIN → HOT コードマスター → 医薬品コード → 処方の薬に入っているか、有効期限）。
// 処方の薬がすべて「合っている」になったら保存できる。合わなかった読み取りも一緒に記録に残す。
// 箱にバーコードの無い薬（生薬など）は読めないので、その行の「目で確かめた」で代える。
import { renderShell, setCrumbs, leave, api, ApiError, escapeHtml, formatDate, formatDateTime, renderPatientBand, unitText, toast, toastNext } from "./app.js";
import { formatQuantity } from "./format.js";
import { icon } from "./icons.js";
import { setTour, autoStartTour } from "./tour.js";

const id = new URLSearchParams(location.search).get("id");
renderShell({ page: "board", title: "調剤監査", crumbs: [{ label: "受付状況", href: "/board" }, { label: "調剤監査" }] });

const { patient, notes, prescription: rx } = await api(`/api/prescriptions/${id}?purpose=inspection`);
setCrumbs([{ label: "受付状況", href: "/board" }, { label: `${patient.name}（${patient.patientNo}）`, href: `/patient?id=${patient.id}` }, { label: "調剤監査" }]);
renderPatientBand(document.querySelector("#band"), patient, notes);
const backHref = rx.receptionId === null ? `/patient?id=${patient.id}` : "/board";
document.querySelector("#back").href = backHref;
document.querySelector("#rx-date").textContent = `調剤日 ${formatDate(rx.dispensedOn)}`;
document.querySelector("#scan-icon").outerHTML = icon("scan", 16);

// 処方の薬（同じ薬が2つの剤にあれば1行にまとめ、総量を足す）
const items = new Map();
for (const rp of rx.rps) {
  for (const it of rp.items) {
    const row = items.get(it.drugCode) ?? { code: it.drugCode, name: it.name, unit: it.unit, totalMilli: 0, matched: null };
    row.totalMilli += it.dailyQtyMilli * rp.days;
    items.set(it.drugCode, row);
  }
}
// 薬ごとの箱のバーコード（デモ用のボタンと、バーコードの無い薬の見分けに使う）
const codes = [...items.keys()];
const demo = await api(`/api/drug-packages?codes=${codes.join(",")}&other=1`);
const boxOf = new Map(codes.map((c) => [c, demo.packages.find((p) => p.drugCode === c) ?? null]));
const expiry = (() => {
  const d = new Date();
  return `${String(d.getFullYear() + 2).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}00`; // 2年後の月末
})();

const scans = []; // { raw, result, ... } 読んだ順
const input = document.querySelector("#scan-input");
const RESULT = {
  match: ["合っている", "処方の薬です"],
  wrong: ["違う薬", "処方に無い薬です。棚に戻して、取り直してください"],
  expired: ["期限切れ", "有効期限を過ぎています。使わないでください"],
  unknown: ["マスターに無い", "HOT コードマスターに無いバーコードです。品名を目で確かめてください"],
};

function renderItems() {
  const done = [...items.values()].filter((x) => x.matched).length;
  document.querySelector("#item-count").textContent = `${done} / ${items.size} 品目 照合済み`;
  document.querySelector("#check-items").innerHTML = [...items.values()].map((x) => {
    const box = boxOf.get(x.code);
    const sub = x.matched?.visual ? "目で確かめた（箱にバーコードの無い薬）"
      : x.matched ? `${escapeHtml(x.matched.package ?? "")}${x.matched.expiry ? `・期限 ${x.matched.expiry}` : ""}${x.matched.lot ? `・ロット ${escapeHtml(x.matched.lot)}` : ""}`
      : box ? "まだ読んでいません" : "箱にバーコードの無い薬です。品名・規格・量を目で確かめてください";
    // 行の操作：バーコードのある薬は、手元に箱が無くても試せるよう、同じ薬の本物のバーコードを読ませる（デモ）。無い薬は目で確かめる
    const action = box
      ? (x.matched ? "" : `<button type="button" class="btn btn-small" data-raw="(01)${box.gtin}(17)${expiry}(10)DEMO01">同じ薬の箱を読む（デモ）</button>`)
      : `<button type="button" class="btn btn-small${x.matched ? "" : " btn-visual"}" data-visual="${x.code}">${x.matched ? "取り消す" : "目で確かめた"}</button>`;
    return `
    <li class="${x.matched ? "done" : ""}" data-code="${x.code}">
      <span class="mark">${x.matched ? icon("check", 18) : ""}</span>
      <span class="name">${escapeHtml(x.name)}</span>
      <span class="qty num">総量 ${formatQuantity(x.totalMilli)}${escapeHtml(unitText(x.unit))}</span>
      <span class="sub">${sub}</span>
      ${action ? `<span class="row-action">${action}</span>` : ""}
    </li>`;
  }).join("");
  document.querySelector("#save").disabled = done !== items.size;
}

function renderLog() {
  document.querySelector("#scan-log").innerHTML = [...scans].reverse().map((s) => `
    <li class="r-${s.result}"><span class="tag">${RESULT[s.result][0]}</span>
      <b>${s.drugName ? escapeHtml(s.drugName) : "（不明な薬）"}</b>
      <div class="sub">GTIN ${s.gtin}${s.package ? `・${escapeHtml(s.package)}` : ""}${s.expiry ? `・期限 ${s.expiry}` : ""}${s.lot ? `・ロット ${escapeHtml(s.lot)}` : ""}</div>
      <div>${RESULT[s.result][1]}</div></li>`).join("");
}

async function read(raw) {
  const err = document.querySelector("#scan-error");
  err.textContent = "";
  let s;
  try {
    s = await api(`/api/prescriptions/${rx.id}/scan`, { method: "POST", body: { raw } });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 422) throw e;
    err.textContent = e.message;
    input.select();
    return;
  }
  scans.push({ raw, ...s });
  if (s.result === "match") items.get(s.drugCode).matched = s;
  renderItems();
  renderLog();
  const row = s.result === "match" ? document.querySelector(`#check-items li[data-code="${s.drugCode}"]`) : document.querySelector("#scan-log li");
  row.classList.add("flash");
  if (s.result !== "match") toast(`${RESULT[s.result][0]}：${RESULT[s.result][1]}`, "error");
  input.value = "";
  input.focus();
}

input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.ctrlKey) return;
  e.preventDefault();
  const raw = input.value.trim();
  if (raw) read(raw);
});

async function save() {
  if (document.querySelector("#save").disabled) return;
  document.querySelector("#save").disabled = true;
  try {
    const visual = [...items.values()].filter((x) => x.matched?.visual).map((x) => x.code);
    const r = await api(`/api/prescriptions/${rx.id}/inspections`, { method: "POST", body: { scans: scans.map((s) => s.raw), visual } });
    toastNext(`調剤監査を保存しました${r.ng ? `（合わない読み取り ${r.ng}件も記録）` : ""}`);
    leave(rx.receptionId === null ? `/patient?id=${patient.id}&saved=${rx.id}` : backHref, { refresh: true }); // 元の画面を開き直す（薬歴なら監査した来局を選ぶ）
  } catch (e) {
    document.querySelector("#save").disabled = false;
    if (!(e instanceof ApiError) || e.status !== 422) throw e;
    toast(e.message, "error");
  }
}
document.querySelector("#save").addEventListener("click", save);
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    save();
  }
});

// 処方の薬の行の操作：同じ薬の箱を読む（デモ）・目で確かめた／取り消す
document.querySelector("#check-items").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.raw) {
    input.value = b.dataset.raw;
    read(b.dataset.raw);
    return;
  }
  const x = items.get(b.dataset.visual);
  x.matched = x.matched ? null : { visual: true };
  renderItems();
  input.focus();
});

// ---------- デモ用：取り違え・期限切れを試す（HOT コードマスターにある本物の GTIN を入れて読む） ----------
const demoBox = document.querySelector("#demo-scan");
if (demo.other) demoBox.insertAdjacentHTML("beforeend", `<button type="button" class="btn btn-ghost btn-small" data-raw="(01)${demo.other.gtin}(17)${expiry}(10)DEMO02">違う薬の箱（${escapeHtml(demo.other.name)}）</button>`);
const firstPkg = demo.packages[0];
if (firstPkg) demoBox.insertAdjacentHTML("beforeend", `<button type="button" class="btn btn-ghost btn-small" data-raw="(01)${firstPkg.gtin}(17)240300(10)OLD01">期限切れの箱</button>`);
demoBox.addEventListener("click", (e) => {
  const b = e.target.closest("[data-raw]");
  if (!b) return;
  input.value = b.dataset.raw;
  read(b.dataset.raw);
});

// ---------- これまでの監査 ----------
const past = await api(`/api/prescriptions/${rx.id}/inspections`);
if (past.length) {
  const box = document.querySelector("#past");
  box.hidden = false;
  box.innerHTML = `<h3>この処方の監査の記録</h3>${past.map((p) => `<div class="past-row">${formatDateTime(p.createdAt)} ${escapeHtml(p.createdBy)}：
    ${p.scans.length}回読み取り（合わない読み取り ${p.scans.filter((s) => s.result !== "match").length}件）${p.visual.length ? `・目で確かめた ${p.visual.length}品目` : ""}</div>`).join("")}`;
}

renderItems();
renderLog();
input.focus();

setTour("inspect", [
  {
    title: "調剤監査：取り出した薬を箱のバーコードで照合",
    body: `<p>処方の薬を棚から取り出したら、箱のバーコードを読みます。<strong>処方と同じ薬か・有効期限が切れていないか</strong>を、目で見る前に機械で確かめます（取り違えの防止）。</p>
      <p>バーコードの商品コード（GTIN）から薬を引くのに、MEDIS の「医薬品HOTコードマスター」（2026年9月30日版）の販売包装単位コードを使っています。</p>`,
  },
  {
    target: ".inspect-items",
    placement: "right",
    title: "処方の薬",
    body: `<p>この処方で渡す薬と総量（1日量 × 日数）です。読んで合った薬に<strong>チェック</strong>が付き、包装・期限・ロットが出ます。全部にチェックが付くと保存できます。</p>
      <p>手元に箱が無いときは、行の<strong>「同じ薬の箱を読む（デモ）」</strong>で、その薬の本物のバーコードの中身を読ませられます。生薬など<strong>箱にバーコードの無い薬</strong>は、目で確かめてから「目で確かめた」を押します。</p>`,
  },
  {
    target: "#scan-input",
    title: "バーコードを読む",
    body: `<p>読み取り機（USB・Bluetooth）はキーボードとして文字と <kbd>Enter</kbd> を送ってくるので、この欄にカーソルがあれば、読むだけで照合します。</p>
      <p>下の<strong>デモ用のボタン</strong>で、違う薬・期限切れの箱を読んだときの動きを試せます。</p>`,
  },
  {
    target: "#scan-log",
    title: "読み取りの記録",
    body: "<p>読んだ順に、新しいものが上です。<strong>違う薬・期限切れ・マスターに無い</strong>ものは赤で出ます。合わなかった読み取りも、保存すると記録に残ります（ヒヤリ・ハットの振り返りに使えます）。</p>",
  },
]);
autoStartTour();
