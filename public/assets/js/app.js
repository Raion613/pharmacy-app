// 全画面共通：画面の骨組み、API 呼び出し、表示用の整形、通知。
import { icon } from "./icons.js";
import { formatSen } from "./format.js";
import { startTour, tourActive } from "./tour.js";
import { NOTE_LABEL } from "./record-kinds.js";
import { burdenText } from "./burden-text.js";
import { kohiBandText } from "./kohi-text.js";

// ---------- 重なる窓の中で開かれたとき ----------
// 薬歴から開く処方入力・領収証などは、薬歴の上に重なる窓（overlay.js）の中に読み込む。そのとき URL に embed=1 が付く。
// 窓の中では左のメニューと上の帯を隠し、「閉じる」「別の画面へ移る」は親（薬歴）に頼む。Esc はどの画面でも窓を閉じる
export const EMBED = new URLSearchParams(location.search).get("embed") === "1";
const toParent = (message) => parent.postMessage(message, location.origin);
if (EMBED) {
  document.documentElement.classList.add("embed");
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]") && !tourActive()) {
      toParent({ type: "overlay:close" });
    }
  });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || e.defaultPrevented) return;
    e.preventDefault();
    leave(a.getAttribute("href"));
  });
}

// 別の画面へ移る。窓の中なら親に頼む（親の画面へ戻るなら窓を閉じる。refresh なら親を新しい内容で開き直す。
// それ以外の画面なら窓の中で開き直す）
export function leave(url, { refresh = false } = {}) {
  if (EMBED) toParent({ type: "overlay:navigate", url, refresh });
  else location.href = url;
}

const NAV = [
  { page: "patients", href: "/patients", label: "患者", icon: "users", key: "1" },
  { page: "board", href: "/board", label: "受付状況", icon: "clipboard", key: "2" },
  { page: "homecare", href: "/homecare", label: "在宅", icon: "home", key: "3" },
  { page: "messages", href: "/messages", label: "つながる薬局", icon: "message", key: "4" },
  { page: "stats", href: "/stats", label: "薬局の数字", icon: "chart", key: "5" },
  { page: "drugs", href: "/drugs", label: "薬価照会", icon: "pill", key: "6" },
  { page: "logs", href: "/logs", label: "閲覧記録", icon: "history", key: "7" },
  { page: "master", href: "/master", label: "マスター取込", icon: "upload", key: "8" },
];

// 左のアイコン列と上の帯を描く。crumbs は [{ label, href? }]。
// back（{ label, href }）を渡した画面は、パンくずの代わりに左上へ「← 戻る」を置き、画面の名前を大きく出す
export function renderShell({ page, title, crumbs, back }) {
  document.title = `${title} | 薬剤料計算・薬歴`;
  const sidebar = document.querySelector(".sidebar");
  sidebar.innerHTML = `<div class="mark" title="薬剤料計算・薬歴"><span>薬</span></div>` + NAV.map((n) =>
    `<a href="${n.href}" ${n.page === page ? 'aria-current="page"' : ""} title="${n.label}（Alt+${n.key}）">${icon(n.icon, 22)}<span>${n.label}</span></a>`,
  ).join("");

  const topbar = document.querySelector(".topbar");
  topbar.classList.toggle("with-back", back !== undefined);
  topbar.innerHTML = `${back ? `<a class="back-button" id="back-button" href="${back.href}">${icon("arrowLeft", 18)}${escapeHtml(back.label)}</a>` : ""}
    <h1>${escapeHtml(title)}</h1>${back ? '<div class="subject" id="subject"></div>' : ""}<span class="spacer"></span>
    <button type="button" class="btn tour-button" id="tour-button" title="この画面の使い方をもう一度見る">${icon("help", 16)}チュートリアル</button>
    <a class="user" id="current-user" href="/account" title="アカウント（多要素認証の設定）"></a>
    <button type="button" class="btn btn-ghost" id="logout">${icon("logOut", 16)}ログアウト</button>`;
  topbar.querySelector("#tour-button").addEventListener("click", startTour);
  topbar.querySelector("#logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: {} });
    location.href = "/login";
  });
  api("/api/me").then((me) => {
    topbar.querySelector("#current-user").textContent = `${me.pharmacyName}　${me.displayName}`;
  });

  if (!back) setCrumbs(crumbs);

  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || EMBED) return;
    const nav = NAV.find((n) => n.key === e.key);
    if (nav) {
      e.preventDefault();
      location.href = nav.href;
    }
  });
}

export function setCrumbs(crumbs) {
  document.querySelector(".crumbs").innerHTML = crumbs.map((c) =>
    c.href ? `<a href="${c.href}">${escapeHtml(c.label)}</a>` : `<span>${escapeHtml(c.label)}</span>`,
  ).join('<span class="sep">›</span>');
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details ?? [];
  }
}

// サーバーの JSON API を呼ぶ。401 ならログイン画面へ。4xx はサーバーの文言付きの ApiError にする。
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith("/api/login")) { // ログインの画面（パスワード・6桁）の 401 は、その画面で文言を出す
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    return new Promise(() => {}); // 画面遷移するので、呼び出し元の続きは実行させない
  }
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error, data.details);
  return data;
}

// 想定外のエラーは隠さず通知する（詳細はコンソール）
window.addEventListener("unhandledrejection", (e) => {
  const message = e.reason instanceof ApiError ? e.reason.message : "処理中にエラーが発生しました。画面を再読み込みしてください";
  toast(message, "error");
});
window.addEventListener("error", () => toast("処理中にエラーが発生しました。画面を再読み込みしてください", "error"));

export function toast(message, kind = "info") {
  let box = document.querySelector(".toasts");
  if (!box) {
    box = document.createElement("div");
    box.className = "toasts";
    box.setAttribute("role", "status");
    document.body.append(box);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => {
    el.classList.add("leaving");
    el.addEventListener("transitionend", () => el.remove());
  }, kind === "error" ? 6000 : 3000);
}

// 別ページから持ち越した通知（保存後の画面遷移など）
export function toastNext(message) {
  sessionStorage.setItem("toast", message);
}
const carried = sessionStorage.getItem("toast");
if (carried) {
  sessionStorage.removeItem("toast");
  queueMicrotask(() => toast(carried));
}

// ---------- 整形 ----------

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// 端末の日付（日本で使う前提）
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEK = "日月火水木金土";
export function formatDate(date) {
  const [y, m, d] = date.split("-");
  return `${y}/${m}/${d}（${WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()]}）`;
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function age(birthDate, on = today()) {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export function birthText(birthDate) {
  const [y, m, d] = birthDate.split("-");
  return `${y}/${m}/${d}（${age(birthDate)}歳）`;
}

export const SEX = { M: "男", F: "女" };

// 画面上部の患者の帯（薬歴・処方入力で共通）。
// アレルギー歴・副作用歴は、どの画面にいても最初に目に入るよう帯の右側に赤で出す。
export function renderPatientBand(el, p, notes) {
  const alerts = notes.filter((n) => n.category === "allergy" || n.category === "adverse");
  const alertHtml = alerts.length
    ? alerts.map((n) => `<span class="alert-chip" title="${escapeHtml(n.body)}">${icon("alert", 14)}<b>${NOTE_LABEL[n.category]}</b>${escapeHtml(n.body)}</span>`).join("")
    : '<span class="alert-none">アレルギー歴・副作用歴の記録なし</span>';
  el.innerHTML = `
    <div><div class="kana">${escapeHtml(p.kana)}</div><div class="name">${escapeHtml(p.name)}</div></div>
    <dl>
      <div><dt>患者番号</dt><dd class="num">${escapeHtml(p.patientNo)}</dd></div>
      <div><dt>生年月日</dt><dd>${birthText(p.birthDate)}</dd></div>
      <div><dt>性別</dt><dd class="sex-${p.sex}">${SEX[p.sex]}</dd></div>
      <div><dt>負担割合</dt><dd><button type="button" class="burden-btn" data-burden title="負担割合を変える">${burdenText(p.burdenPercent, p.burdenReason)}</button></dd></div>
      <div><dt>公費</dt><dd><button type="button" class="burden-btn" data-kohi title="公費（受給者証）を見る・足す">${escapeHtml(kohiBandText(p.kohi, today()))}</button></dd></div>
      <div><dt>最終来局日</dt><dd>${p.lastDispensedOn ? formatDate(p.lastDispensedOn) : "—"}</dd></div>
    </dl>
    <div class="alerts" id="band-alerts">${alertHtml}</div>`;
}

// 薬価の表示。医薬品マスターの金額は1錠・1g・1mL など最小単位当たり。単位の無い薬は規格単位当たり
export function priceText(priceSen, unit) {
  return `${formatSen(priceSen)}円<span class="per">/${unit === "" ? "規格単位" : `1${escapeHtml(unit)}`}</span>`;
}

// 1日量の単位（単位の無い薬は規格単位の数）
export function unitText(unit) {
  return unit === "" ? "規格単位" : unit;
}

export function pointsText(points) {
  return `${points.toLocaleString()}点`;
}

// 薬の区分の札。後発品と、長期収載品の選定療養（区分 1：医療上必要な場合のコード、区分 2：患者希望のコード）
export function drugTags(d) {
  return [
    d.generic ? '<span class="tag tag-generic">後発品</span>' : "",
    d.sentei === 1 ? '<span class="tag tag-original" title="後発品のある先発品。患者が希望して受け取ると選定療養（（選）のコードを使う）">長期収載品</span>' : "",
    d.sentei === 2 ? '<span class="tag tag-warn" title="患者希望の長期収載品。薬剤料はこのコードの金額で、別に特別の料金がかかる">選定療養（患者希望）</span>' : "",
  ].join("");
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// 一覧の行を ↑↓ で選び Enter で開く。rows が変わるたびに呼び直す。
export function listNavigator({ container, rowSelector, onOpen, onSelect = () => {} }) {
  let index = -1;
  const rows = () => [...container.querySelectorAll(rowSelector)];
  const select = (i, scroll = true) => {
    const all = rows();
    if (all.length === 0) return;
    index = Math.max(0, Math.min(i, all.length - 1));
    all.forEach((r, j) => r.setAttribute("aria-selected", String(j === index)));
    if (scroll) all[index].scrollIntoView({ block: "nearest" });
    onSelect(all[index], index);
  };
  return {
    get index() { return index; },
    select,
    reset() { index = -1; },
    handleKey(e) {
      const all = rows();
      if (all.length === 0) return false;
      if (e.key === "ArrowDown") select(index + 1);
      else if (e.key === "ArrowUp") select(index - 1);
      else if (e.key === "Enter" && index >= 0) onOpen(all[index]);
      else return false;
      e.preventDefault();
      return true;
    },
  };
}
