// 受付状況：今日受け付けた処方箋が、受付 → 入力 → 監査 → 投薬 → 会計 のどこまで進んでいて、患者が何分待っているかを薬局の全員で見る。
//   入力済み … 受付から処方入力の画面を開いて保存したとき（処方入力の保存処理が足す）
//   監査済み … 調剤監査の画面で、処方の薬をすべてバーコードで照合して保存したとき（監査の保存処理が足す）
//   投薬・会計 … この画面のボタンで足す
// 待ち時間は、受付から投薬までの時間（投薬が済んでいなければ今まで）。
import { renderShell, api, ApiError, escapeHtml, today, toast, debounce, listNavigator } from "./app.js";
import { icon } from "./icons.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";
import "./overlay.js"; // data-overlay のリンクは重なる窓で開く
import { burdenCheck, openBurdenDialog } from "./burden-ui.js";

renderShell({ page: "board", title: "受付状況", crumbs: [{ label: "受付状況" }] });

const COLUMNS = [
  { key: "received", label: "入力待ち" },
  { key: "entered", label: "監査待ち" },
  { key: "audited", label: "投薬待ち" },
  { key: "handed", label: "会計待ち" },
  { key: "paid", label: "会計済み" },
];
const LONG_WAIT_MIN = 20; // これより長く待たせている患者を赤で示す

const dateInput = document.querySelector("#board-date");
const boardEl = document.querySelector("#board");
const q = document.querySelector("#reception-q");
const suggest = document.querySelector("#reception-suggest");
document.querySelector("#search-icon").outerHTML = icon("search", 16);
dateInput.value = today();
let receptions = [];

const stageOf = (r) => (r.steps.paid ? "paid" : r.steps.handed ? "handed" : r.steps.audited ? "audited" : r.steps.entered ? "entered" : "received");
const minutes = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
const hhmm = (iso) => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

async function load() {
  receptions = await api(`/api/receptions?date=${dateInput.value}`);
  render();
}

function render() {
  const now = new Date().toISOString();
  const groups = Map.groupBy(receptions, stageOf);
  boardEl.innerHTML = COLUMNS.map((c) => {
    const list = groups.get(c.key) ?? [];
    return `<section class="board-col col-${c.key}" aria-label="${c.label}">
      <header><b>${c.label}</b><span class="count">${list.length}</span></header>
      <div class="board-cards">${list.map((r) => cardHtml(r, c.key, now)).join("") || '<p class="empty">なし</p>'}</div>
    </section>`;
  }).join("");
  const waiting = receptions.filter((r) => !r.steps.handed);
  const done = receptions.filter((r) => r.steps.handed);
  const avg = done.length ? Math.round(done.reduce((s, r) => s + minutes(r.receivedAt, r.steps.handed.at), 0) / done.length) : null;
  document.querySelector("#board-summary").innerHTML = `
    <div><dt>受付</dt><dd class="num">${receptions.length}件</dd></div>
    <div><dt>お待ちの患者</dt><dd class="num">${waiting.length}人</dd></div>
    <div><dt>平均の待ち時間（投薬まで）</dt><dd class="num">${avg === null ? "—" : `${avg}分`}</dd></div>`;
}

function cardHtml(r, stage, now) {
  const wait = minutes(r.receivedAt, r.steps.handed?.at ?? now);
  const long = !r.steps.handed && wait >= LONG_WAIT_MIN;
  const action = {
    received: `<a class="btn btn-small btn-primary" data-overlay href="/rx?patient=${r.patientId}&reception=${r.id}">処方を入力</a>`,
    entered: `<a class="btn btn-small btn-primary" data-overlay href="/inspect?id=${r.prescriptionId}">調剤監査</a>`,
    audited: `<button type="button" class="btn btn-small btn-primary" data-step="handed" data-id="${r.id}">投薬した</button>`,
    handed: `<button type="button" class="btn btn-small btn-primary" data-step="paid" data-id="${r.id}">会計した</button>`,
    paid: "",
  }[stage];
  const steps = ["entered", "audited", "handed", "paid"].filter((s) => r.steps[s])
    .map((s) => `${{ entered: "入力", audited: "監査", handed: "投薬", paid: "会計" }[s]} ${hhmm(r.steps[s].at)}`).join(" → ");
  return `<article class="board-card ${long ? "long" : ""}" data-id="${r.id}">
    <div class="bc-head"><a href="/patient?id=${r.patientId}" data-overlay class="bc-name">${escapeHtml(r.patient.name)}</a><span class="bc-no">${escapeHtml(r.patient.patientNo)}</span></div>
    <div class="bc-time"><span>受付 ${hhmm(r.receivedAt)}</span><span class="bc-wait num" title="受付から${r.steps.handed ? "投薬まで" : "今まで"}">${wait}分${r.steps.handed ? "" : "待ち"}</span></div>
    ${steps ? `<div class="bc-steps">${steps}</div>` : ""}
    ${action ? `<div class="bc-actions">${action}</div>` : ""}
  </article>`;
}

boardEl.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-step]");
  if (!b) return;
  b.disabled = true;
  try {
    await api(`/api/receptions/${b.dataset.id}/steps`, { method: "POST", body: { step: b.dataset.step } });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 422) throw err;
    toast(err.message, "error");
  }
  await load();
  const moved = boardEl.querySelector(`.board-card[data-id="${b.dataset.id}"]`);
  moved.classList.add("flash");
  (moved.querySelector(".bc-actions .btn") ?? moved.querySelector(".bc-name")).focus();
});

dateInput.addEventListener("change", load);

// ---------- 受付 ----------

let candidates = [];
const nav = listNavigator({ container: suggest, rowSelector: "li[data-k]", onOpen: (li) => receive(candidates[Number(li.dataset.k)]) });

const search = debounce(async () => {
  const text = q.value.trim();
  if (text === "") {
    suggest.hidden = true;
    return;
  }
  candidates = await api(`/api/patients?q=${encodeURIComponent(text)}`);
  suggest.innerHTML = candidates.length
    ? candidates.slice(0, 8).map((p, k) => `<li data-k="${k}" role="option"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.kana)}</span><span class="num">${escapeHtml(p.patientNo)}</span></li>`).join("")
    : '<li class="none">該当する患者がいません</li>';
  suggest.hidden = false;
  nav.reset();
  if (candidates.length) nav.select(0, false);
}, 200);

q.addEventListener("input", search);
q.addEventListener("keydown", (e) => {
  if (e.isComposing || suggest.hidden) return;
  if (e.key === "Escape") {
    suggest.hidden = true;
    return;
  }
  nav.handleKey(e);
});
suggest.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-k]");
  if (li) {
    e.preventDefault();
    receive(candidates[Number(li.dataset.k)]);
  }
});

async function receive(p) {
  if (dateInput.value !== today()) {
    toast("受付は今日の日付で行います。日付を今日に戻してください", "error");
    return;
  }
  try {
    await api("/api/receptions", { method: "POST", body: { patientId: p.id } });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 422) throw err;
    toast(err.details[0].message, "error");
    return;
  }
  q.value = "";
  suggest.hidden = true;
  await load();
  toast(`${p.name}さんの処方箋を受け付けました`);
  // 受付で保険証を確かめるとき、前回より後に年齢で負担割合が変わりうる日を過ぎていたら、その場で確かめる
  if (burdenCheck(p, today()).needed) await openBurdenDialog(p, today());
  const card = [...boardEl.querySelectorAll(".col-received .board-card")].at(-1);
  card.classList.add("flash");
  card.querySelector(".btn").focus();
}

document.addEventListener("keydown", (e) => {
  if (e.altKey && e.code === "KeyU" && !tourActive()) {
    e.preventDefault();
    q.focus();
  }
});

// 他の人の操作も映すため、30秒ごとに読み直す（待ち時間も進む）
setInterval(() => {
  if (!document.hidden && document.activeElement !== q) load();
}, 30000);

await load();
q.focus();

setTour("board", [
  {
    title: "受付状況：誰が・どこまで・何分",
    body: `<p>今日受け付けた処方箋が、<strong>受付 → 入力 → 監査 → 投薬 → 会計</strong>のどこまで進んでいて、患者さんが何分待っているかを、薬局の全員で見る画面です。</p>
      <p>30秒ごとに読み直すので、ほかの人が進めた分もここに映ります。</p>`,
  },
  {
    target: ".reception-search",
    title: "処方箋を受け付ける",
    body: `<p>患者番号・カナ・氏名を打つと候補が出ます。<kbd>↑</kbd><kbd>↓</kbd> で選んで <kbd>Enter</kbd> で受付です。<kbd>Alt</kbd>+<kbd>U</kbd> でこの欄に戻れます。</p>
      <p>会計が済んでいない受付がある患者は、重ねて受け付けません（二重の受付を防ぐ）。</p>`,
  },
  {
    target: "#board",
    title: "段階ごとの列",
    body: `<ul>
        <li><b>入力待ち</b>：「処方を入力」で処方入力へ。保存すると、自動で次の列へ移ります</li>
        <li><b>監査待ち</b>：「調剤監査」で、取り出した薬の箱のバーコードを読みます。全部合えば次の列へ</li>
        <li><b>投薬待ち・会計待ち</b>：渡した・会計したら、ボタンで進めます</li>
      </ul>
      <p>受付から${LONG_WAIT_MIN}分以上お待たせしている患者さんの札は<strong>赤</strong>になります。</p>`,
  },
  {
    target: "#board-summary",
    title: "今日の数字",
    body: "<p>受付の件数、まだ薬を渡していない人数、受付から投薬までの平均の時間です。</p>",
  },
]);
autoStartTour();
