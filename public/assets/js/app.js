// 全画面共通：画面の骨組み、API 呼び出し、表示用の整形、通知。
import { icon } from "./icons.js";
import { formatSen, formatQuantity } from "./format.js";
import { startTour, tourActive } from "./tour.js";
import { NOTE_LABEL } from "./record-kinds.js";
import { burdenText } from "./burden-text.js";
import { kohiBandText } from "./kohi-text.js";

// ---------- 重なる窓の中で開かれたとき ----------
// 薬歴から開く処方入力・領収証などは、薬歴の上に重なる窓（overlay.js）の中に読み込む。そのとき URL に embed=1 が付く。
// 窓の中では左のメニューと上の帯を隠し、「閉じる」「別の画面へ移る」は親（薬歴）に頼む。Esc はどの画面でも窓を閉じる
export const EMBED = new URLSearchParams(location.search).get("embed") === "1";
export const toParent = (message) => parent.postMessage(message, location.origin);
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
// それ以外の画面なら窓の中で開き直す）。窓の外では router.js が中身だけを差し替える（kind は切り替えの向き）
let navigate = (url) => { location.href = url; };
export function setNavigator(fn) {
  navigate = fn;
}
export function leave(url, { refresh = false, kind } = {}) {
  if (EMBED) toParent({ type: "overlay:navigate", url, refresh });
  else navigate(url, { kind });
}
// 同じ画面を別の条件で開き直す（履歴を積まない）
export function reopen(url) {
  if (EMBED) location.replace(url);
  else navigate(url, { kind: "none", replace: true });
}

const NAV = [
  { page: "board", href: "/board", label: "受付状況", icon: "clipboard", key: "1" },
  { page: "patients", href: "/patients", label: "患者", icon: "users", key: "2" },
  { page: "homecare", href: "/homecare", label: "在宅", icon: "home", key: "3" },
  { page: "messages", href: "/messages", label: "つながる薬局", icon: "message", key: "4" },
  { page: "stats", href: "/stats", label: "薬局の数字", icon: "chart", key: "5" },
  { page: "drugs", href: "/drugs", label: "薬価照会", icon: "pill", key: "6" },
  { page: "logs", href: "/logs", label: "閲覧記録", icon: "history", key: "7" },
  { page: "master", href: "/master", label: "マスター取込", icon: "upload", key: "8" },
];

// 左上の「薬」は回覧板（本部からの伝達・申し送り）へのボタン。まだ確認していない投稿があれば印を付ける。Alt+0
const HOME = { page: "home", href: "/home", key: "0" };

// 左のアイコン列と上の帯を描く。crumbs は [{ label, href? }]。
// back（{ label, href }）を渡した画面は、パンくずの代わりに左上へ「← 戻る」を置き、画面の名前を大きく出す
// 左のアイコン列は一度だけ描き、画面を移っても残す（今の画面の印だけ付け替える）
let me = null;
export function renderShell({ page, title, crumbs, back }) {
  document.title = `${title} | 薬剤料計算・薬歴`;
  const sidebar = document.querySelector(".sidebar");
  if (sidebar.childElementCount === 0) {
    sidebar.innerHTML = `<a class="mark" href="${HOME.href}" data-page="${HOME.page}" title="回覧板（Alt+${HOME.key}）"><span>薬</span><i class="unread-dot" id="unread-dot" hidden></i></a>` + NAV.map((n) =>
      `<a href="${n.href}" data-page="${n.page}" title="${n.label}（Alt+${n.key}）">${icon(n.icon, 22)}<span>${n.label}</span></a>`,
    ).join("");
  }
  for (const a of sidebar.querySelectorAll("a")) {
    if (a.dataset.page === page) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }

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
  me ??= api("/api/me", { background: true });
  me.then((m) => {
    topbar.querySelector("#current-user").textContent = `${m.pharmacyName}　${m.displayName}`;
  });

  if (!back) setCrumbs(crumbs);
  refreshUnreadDot();

  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || EMBED) return;
    const nav = [HOME, ...NAV].find((n) => n.key === e.key);
    if (nav) {
      e.preventDefault();
      leave(nav.href, { kind: "tab" });
    }
  });
}

export async function refreshUnreadDot() {
  const { count } = await api("/api/notices/unread", { background: true });
  const dot = document.querySelector("#unread-dot");
  dot.hidden = count === 0;
  dot.title = `まだ確認していない投稿 ${count}件`;
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
//   画面を移ったら（startPage）、前の画面が出した通信の続きは動かさない（離れた画面が、新しい画面の部品を書き換えないように）。
//   画面を開いた直後の通信が全部終わったら whenIdle が解ける（router.js はそれを見て中身を出す）。background の通信は待たない。
//   押した瞬間に先に引いておいた結果（prefetch）があれば、画面を開いている間（mount の最中）だけそれを使う（10秒より古ければ引き直す）。
//   画面を開いた後の読み直し（保存した後など）は必ず引き直す。保存（GET 以外）をしたら、先読みは全部捨てる（古くなっているかもしれない）
let pageGen = 0;
let inflight = 0;
let idleWaiters = [];
let recording = null; // 画面を開いた直後に引いた GET（router.js が覚えて、次に同じ画面を開くときに先に引く）
const prefetched = new Map();

export function startPage() {
  pageGen++;
  inflight = 0;
  idleWaiters = [];
  recording = [];
}
export function stopRecording() {
  const list = recording;
  recording = null;
  return list;
}
export function whenIdle() {
  return inflight === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve));
}
export function prefetch(path) {
  if (prefetched.has(path) && performance.now() - prefetched.get(path).at < 10000) return;
  const data = request(path, "GET");
  data.catch(() => {}); // 使われなかった先読みの失敗は通知しない（使うときは、使う側に同じ失敗が届く）
  prefetched.set(path, { at: performance.now(), data });
}
function takePrefetched(path) {
  const p = prefetched.get(path);
  if (p === undefined) return undefined;
  prefetched.delete(path);
  return performance.now() - p.at < 10000 ? p.data : undefined;
}

export async function api(path, { method = "GET", body, background = false } = {}) {
  const gen = pageGen;
  if (!background) inflight++;
  if (method === "GET" && !background && recording !== null) recording.push(path);
  try {
    if (method !== "GET") prefetched.clear();
    const pre = method === "GET" && recording !== null ? takePrefetched(path) : undefined;
    const data = await (pre ?? request(path, method, body));
    if (gen !== pageGen) return new Promise(() => {});
    return data;
  } catch (e) {
    if (gen !== pageGen) return new Promise(() => {});
    throw e;
  } finally {
    // 0 になっても、受け取った側が描き終わる（と、続けて次の通信を出す）のを待ってから「そろった」とする
    if (!background && gen === pageGen && --inflight === 0) setTimeout(() => {
      if (gen !== pageGen || inflight > 0) return;
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    });
  }
}
async function request(path, method, body) {
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

// ---------- 押した物は必ず動いて応える ----------
// ボタン・選択肢・開閉の見出し・候補を押した瞬間に、小さく潰れて戻る（トゥーンの「潰れて戻る」をごく小さく）。
// 何千回押しても邪魔にならないよう、0.16秒・最大3%・音なし・形（transform）だけで、レイアウトは動かさない。
// 横に長い物（選択肢の行など）は潰さず、わずかに沈むだけにする。マウスでも、Enter / Space で押したときも同じ動き
// 段ごとに曲線をかける（WAAPI は書かないと段と段の間が等速になる）
const PRESS_POP = [
  { transform: "translateY(1px) scale(1.02, .94)", easing: "cubic-bezier(.65, 0, .35, 1)" },
  { transform: "translateY(-1px) scale(.99, 1.03)", offset: .45, easing: "cubic-bezier(.65, 0, .35, 1)" },
  { transform: "none" },
];
const PRESS_WIDE = [{ transform: "scale(.985)", easing: "cubic-bezier(.16, 1, .3, 1)" }, { transform: "none" }];
const PRESSABLE = "button, .btn, summary, [role='option'], label:has(input[type='radio'], input[type='checkbox'])";
export const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");
document.addEventListener("click", (e) => {
  if (REDUCED_MOTION.matches || e.target.matches("input")) return; // ラベルを押すと入力欄にもクリックが届くので、二重に動かさない
  const el = e.target.closest(PRESSABLE);
  if (!el) return;
  el.animate(el.offsetWidth > 220 ? PRESS_WIDE : PRESS_POP, { duration: 160 });
});

// 押して画面を移る物（行・札・カード・メニュー）は、押し下げた瞬間に押した跡を付ける（離すのを待たない）。画面を移らなければすぐ消す
document.addEventListener("pointerdown", (e) => {
  const nav = e.target.closest("tr, .board-card, .visit-card, .sidebar a");
  if (nav === null) return;
  nav.classList.add("pressed");
  setTimeout(() => nav.classList.remove("pressed"), 600);
});

// ---------- 窓は、押した物から広がって開き、閉じると押した物へ縮んで戻る ----------
// 押したボタン・行・札・箱の位置と大きさから、窓を広げる（iPhone のホーム画面でアプリを開く動き）。
// 閉じるときは同じ形へ戻る（app.css の dialog:not([open]) が --dialog-from を使う）。押した物が分からなければ、下から浮かぶ。
// 窓は押した瞬間に開く（中身の通信を待たない。届いたものから窓の中に入る）。
// 動かすのは形（transform）と透明度（opacity）だけ。どちらも描き直しが要らず、画面を描く処理と別に動くので、重い画面でもコマが落ちない。
// 曲線は app.css の --ease-out（一瞬で出てピタッと止まる）と --ease-fade（背景の暗さ）。パネルの大きさなので 0.28秒
let lastPress = null;
window.addEventListener("pointerdown", (e) => { lastPress = { el: e.target, at: performance.now() }; }, true);
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " " || e.altKey || e.ctrlKey) lastPress = { el: document.activeElement, at: performance.now() };
}, true);
function pressOrigin(dialog) {
  if (lastPress === null || performance.now() - lastPress.at > 5000 || !(lastPress.el instanceof Element) || !lastPress.el.isConnected) return null;
  const el = lastPress.el.closest(".board-card, .visit-card, tr, .pbox-body li, .pbox") ?? lastPress.el.closest(".btn, button, a, summary, label, [role='option']");
  return el === null || dialog.contains(el) ? null : el;
}
const ROOT_STYLE = getComputedStyle(document.documentElement);
const EASE_OUT = ROOT_STYLE.getPropertyValue("--ease-out"), EASE_FADE = ROOT_STYLE.getPropertyValue("--ease-fade");
// 押した物への変換：窓全体を縦横同じ比率で縮めて、押した物の中に収まる大きさ・中心にする
function originShape(d, el) {
  const r = d.getBoundingClientRect(), o = el.getBoundingClientRect();
  const s = Math.min(o.width / r.width, o.height / r.height, 1);
  return `translate(${o.left + o.width / 2 - (r.left + r.width / 2)}px, ${o.top + o.height / 2 - (r.top + r.height / 2)}px) scale(${s})`;
}
// 開いた合図（toggle）は1コマ描いた後に届くので、開く直前に窓と背景を見えなくしておく（app.css の dialog.opening）。
// そうしないと最初のコマで、窓が素のまま・背景が最終の暗さで一度に出てしまう
document.addEventListener("beforetoggle", (e) => {
  if (e.target instanceof HTMLDialogElement && e.newState === "open" && !REDUCED_MOTION.matches) e.target.classList.add("opening");
}, true);
document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDialogElement) || e.newState !== "open") return;
  const el = pressOrigin(d);
  const from = el === null ? "translateY(28px) scale(.94)" : originShape(d, el);
  d.style.setProperty("--dialog-from", from);
  if (REDUCED_MOTION.matches) return;
  d.animate([{ transform: from }, { transform: "none" }], { duration: 280, easing: EASE_OUT });
  d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: EASE_FADE, pseudoElement: "::backdrop" });
  d.classList.remove("opening"); // 動きを付けてから外す（同じコマで、動きの最初の状態から見え始める）
}, true);

// ---------- 確かめる・名前を聞く窓 ----------
// ブラウザの confirm・prompt は使わない（ブラウザ全体の操作を止め、アプリの窓とも見た目が違う）。
// 窓は聞くたびに作り、閉じる動きが終わったら外す
function ask({ title, body = "", ok, cancel = "キャンセル", input = null }) {
  const d = document.createElement("dialog");
  d.className = "ask-dialog";
  d.innerHTML = `<form novalidate>
    <div class="panel-head">${escapeHtml(title)}</div>
    <div class="dialog-body">${body ? `<p>${escapeHtml(body)}</p>` : ""}${input ? `
      <label class="field"><span class="label">${escapeHtml(input.label)}</span>
        <input class="input" name="text" maxlength="${input.maxLength}" autocomplete="off"></label>` : ""}</div>
    <div class="dialog-foot">
      <button type="button" class="btn" data-cancel>${escapeHtml(cancel)} <kbd>Esc</kbd></button>
      <button type="submit" class="btn btn-primary">${escapeHtml(ok)}（Enter）</button>
    </div>
  </form>`;
  document.body.append(d);
  const form = d.querySelector("form");
  return new Promise((resolve) => {
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close());
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      d.close("ok");
    });
    d.addEventListener("close", () => {
      resolve(d.returnValue === "ok" ? (input ? form.elements.text.value : "") : null);
      requestAnimationFrame(() => Promise.allSettled(d.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => d.remove()));
    }, { once: true });
    d.showModal();
    (input ? form.elements.text : form.querySelector("[type=submit]")).focus();
  });
}

// 「はい」なら true
export async function askConfirm({ title, body, ok, cancel }) {
  return (await ask({ title, body, ok, cancel })) !== null;
}

// 打った文字。やめたら null
export function askText({ title, label, maxLength, ok }) {
  return ask({ title, ok, input: { label, maxLength } });
}

// 別の画面から持ち越した通知（保存して画面を移ったときなど）。router.js が新しい画面を出したところで呼ぶ
export function showCarriedToast() {
  const carried = sessionStorage.getItem("toast");
  if (carried === null) return;
  sessionStorage.removeItem("toast");
  toast(carried);
}

// ---------- 隠れていた部品が出るときは、浮かび上がらせる ----------
// 画面のどこでも、hidden が外れた瞬間に動かす（部品ごとに書かない。新しく足した部品にも効く）。
// 消えるときの動きは、候補の一覧などの CSS（app.css の「窓・吹き出し・切り替わる部品の動き」）
new MutationObserver((records) => {
  if (REDUCED_MOTION.matches || !document.documentElement.classList.contains("page-ready")) return; // 画面を組み立てている間（まだ見えていない）は動かさない
  for (const r of records) {
    if (r.oldValue === null || r.target.hidden) continue;
    r.target.animate([{ opacity: 0, translate: "0 6px" }, { opacity: 1, translate: "0 0" }], { duration: 200, easing: EASE_OUT });
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["hidden"], attributeOldValue: true, subtree: true });

// 想定外のエラーは隠さず通知する（詳細はコンソール）
window.addEventListener("unhandledrejection", (e) => {
  // 画面を移ると、前の画面の途中の通信はブラウザが取り消す（AbortError）。離れた画面の通信なので誤りではない。
  // 次の画面がそろうまで前の画面を残しているので、前の画面がこの取り消しを受け取ることがある
  if (e.reason instanceof DOMException && e.reason.name === "AbortError") {
    e.preventDefault();
    return;
  }
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

// 次の画面で出す通知（保存して画面を移るときなど）
export function toastNext(message) {
  sessionStorage.setItem("toast", message);
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
// 患者のお薬手帳の形態（patients.handbook_kind）。null はまだ聞いていない
export const HANDBOOK_KIND = { electronic: "電子版", paper: "紙", none: "持っていない" };

// 画面上部の患者の帯（薬歴・処方入力で共通）。
// アレルギー歴・副作用歴は、どの画面にいても最初に目に入るよう帯の右側に赤で出す。
// editable：負担割合・公費をその画面で変えられるとき（処方入力）だけ押せる形にする。変えられない画面（調剤監査）は文字だけ
export function renderPatientBand(el, p, notes, { editable = false } = {}) {
  const burden = burdenText(p.burdenPercent, p.burdenReason);
  const kohi = escapeHtml(kohiBandText(p.kohi, today()));
  const alerts = notes.filter((n) => n.category === "allergy" || n.category === "adverse");
  const alertHtml = alerts.length
    ? alerts.map((n) => `<span class="alert-chip" title="${escapeHtml(n.body)}">${icon("alert", 14)}<b>${NOTE_LABEL[n.category]}</b>${escapeHtml(n.body.replaceAll("\n", "／"))}</span>`).join("")
    : '<span class="alert-none">アレルギー歴・副作用歴の記録なし</span>';
  el.innerHTML = `
    <div><div class="kana">${escapeHtml(p.kana)}</div><div class="name">${escapeHtml(p.name)}</div></div>
    <dl>
      <div><dt>患者番号</dt><dd class="num">${escapeHtml(p.patientNo)}</dd></div>
      <div><dt>生年月日</dt><dd>${birthText(p.birthDate)}</dd></div>
      <div><dt>性別</dt><dd class="sex-${p.sex}">${SEX[p.sex]}</dd></div>
      <div><dt>負担割合</dt><dd>${editable ? `<button type="button" class="burden-btn" data-burden title="負担割合を変える">${burden}</button>` : burden}</dd></div>
      <div><dt>公費</dt><dd>${editable ? `<button type="button" class="burden-btn" data-kohi title="公費（受給者証）を見る・足す">${kohi}</button>` : kohi}</dd></div>
      <div><dt>お薬手帳</dt><dd>${HANDBOOK_KIND[p.handbookKind] ?? "未確認"}</dd></div>
      <div><dt>最終来局日</dt><dd>${p.lastDispensedOn ? formatDate(p.lastDispensedOn) : "—"}</dd></div>
    </dl>
    <div class="alerts" id="band-alerts">${alertHtml}</div>`;
}

// 薬価の表示。医薬品マスターの金額は1錠・1g・1mL など最小単位当たり。単位の無い薬は規格単位当たり
export function priceText(priceSen, unit) {
  return `${formatSen(priceSen)}円<span class="per">/${unit === "" ? "規格単位" : `1${escapeHtml(unit)}`}</span>`;
}

// 1日量の単位（単位の無い薬は規格単位の数）
// 在庫（計算上の数）の表示。null は在庫を記録していない薬。処方で引きすぎるとマイナスになる
export function stockText(milli, unit) {
  if (milli === null) return '<span class="stock none">在庫の記録なし</span>';
  return `<span class="stock${milli <= 0 ? " out" : ""}">在庫 ${milli < 0 ? "−" : ""}${formatQuantity(Math.abs(milli))}${escapeHtml(unitText(unit))}</span>`;
}

export function unitText(unit) {
  return unit === "" ? "規格単位" : unit;
}

export function pointsText(points) {
  return `${points.toLocaleString()}点`;
}

// 薬の区分の札。後発品と、長期収載品の選定療養（区分 1：医療上必要な場合のコード、区分 2：患者希望のコード）
export function drugTags(d) {
  return [
    d.adopted ? '<span class="tag tag-adopted" title="この薬局の採用薬。処方入力の候補で一番上に出る">採用</span>' : "",
    d.generic ? '<span class="tag tag-generic">後発品</span>' : "",
    d.sentei === 1 ? '<span class="tag tag-original" title="後発品のある先発品。患者が希望して受け取ると選定療養（（選）のコードを使う）">長期収載品</span>' : "",
    d.sentei === 2 ? '<span class="tag tag-warn" title="患者希望の長期収載品。薬剤料はこのコードの金額で、別に特別の料金がかかる">選定療養（患者希望）</span>' : "",
  ].join("");
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    const gen = pageGen;
    t = setTimeout(() => { if (gen === pageGen) fn(...args); }, ms); // 待つ間に画面を移ったら動かさない（消えた欄に書きに行く）
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
