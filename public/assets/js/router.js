// 画面の切り替え。左のメニュー・重なる窓・通知の置き場は一度だけ作って残し、画面を移るときは中身（.main と画面の窓）だけを差し替える。
// iPhone のアプリや、ブラウザで動く業務アプリ（Gmail など）と同じ作り：ページを丸ごと読み直さないので、押した瞬間に切り替えが動き出せる。
//
//   先に持っておく：各画面の HTML・CSS・JS は、最初の画面が出たあと手の空いた時間に読んでおく（画面の部品で、患者のデータは入っていない）。
//                   患者のデータは、押した瞬間（pointerdown・Enter）に引き始める。何を引くかは、その画面を前に開いたときに引いた通信を覚えておく。
//                   患者を開かずに引くと閲覧記録が残るので、マウスを乗せただけでは患者のデータを引かない（一覧の画面の分だけ引く）
//   切り替える：  document.startViewTransition で、前の画面の写しと新しい画面を動かす（動きは app.css の「画面の切り替え」）。
//                 新しい画面は、データがそろって描き終わったら動かし始める。0.06秒待ってもそろわなければ骨組み（上の帯・パンくず・下の操作バー）だけで動かし始め、
//                 遅れれば中身だけを、そろったところで浮かび上がらせる
//   窓の下描き：  画面が出たら、手の空いた時間に画面の窓を一度だけ見えない形で描いておく。大きな窓は初めて描くときに文字の形を作るのに
//                 数コマかかり、開く動きの最初がつかえるため（2回目からは速い）
//   片付ける：    画面の処理（各画面の mount）が window・document に付けた受け口と setInterval は、画面を移るときにまとめて外す
//
// 各 HTML は <script type="module" src="/assets/js/router.js" data-page="/assets/js/○○.js"> を1つだけ読む。
// 重なる窓の中（embed=1）とログイン画面などの別の作りの画面へは、ページを丸ごと読み直す
import { EMBED, REDUCED_MOTION, toParent, setNavigator, startPage, stopRecording, whenIdle, prefetch, showCarriedToast, askConfirm } from "./app.js";
import { endTour } from "./tour.js";
import "./overlay.js";

const root = document.documentElement;
// データを待ってよい長さ（ミリ秒）。準備の間は画面が止まるので長くは待たない。押して（離して）から動き出すまでを 0.1秒より短く保つ
// （0.1秒以内の反応は「すぐ」と感じられる。web.dev の RAIL）。患者のデータは押し下げた瞬間に引き始めているので、たいていこの間にそろう
const BUDGET = 60;
const COMMON_CSS = ["/assets/css/app.css", "/assets/css/tour.css"];
const nativeListen = EventTarget.prototype.addEventListener;

// ---------- 画面の持ち物の片付け ----------
let scope = new AbortController();
function scoped() {
  for (const target of [window, document]) {
    target.addEventListener = function (type, listener, options) {
      const o = typeof options === "boolean" ? { capture: options } : { ...options };
      o.signal ??= scope.signal;
      nativeListen.call(this, type, listener, o);
    };
  }
  const nativeInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => {
    const id = nativeInterval(fn, ms, ...args);
    scope.signal.addEventListener("abort", () => clearInterval(id));
    return id;
  };
}

// ---------- 画面の部品（HTML・CSS・JS）を先に持つ ----------
const docs = new Map(); // パス → Promise<Document | null>（ログイン画面などへ回されたら null）
function pageDoc(path) {
  if (!docs.has(path)) {
    const d = fetch(path).then(async (res) => (res.ok && !res.redirected ? new DOMParser().parseFromString(await res.text(), "text/html") : null));
    docs.set(path, d);
    d.then((x) => { if (x === null) docs.delete(path); }, () => docs.delete(path));
  }
  return docs.get(path);
}
const pageScript = (doc) => doc.querySelector("script[data-page]")?.dataset.page;
const pageCss = (doc) => [...doc.head.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href")).filter((h) => !COMMON_CSS.includes(h));

// 画面の CSS は一度読んだら外さず、使わない画面の分は media="not all" で効かなくしておく（付け直すたびに読み直さない。
// disabled にすると、ブラウザによっては読み込み自体を始めない）
const sheets = new Map(); // href → <link>
for (const l of document.head.querySelectorAll('link[rel="stylesheet"]')) sheets.set(l.getAttribute("href"), l);
function loadSheet(href) {
  if (sheets.has(href)) return Promise.resolve(sheets.get(href));
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  l.media = "not all";
  sheets.set(href, l);
  document.head.append(l);
  return new Promise((resolve, reject) => {
    l.addEventListener("load", () => resolve(l));
    l.addEventListener("error", reject);
  });
}

// 画面を開いた直後に引いた通信を、画面のパスごとに覚える。URL の値（?id=7 の 7）は {id} に置き換えて、別の患者でも使えるようにする
const learned = JSON.parse(localStorage.getItem("page-data") ?? "{}");
function learn(url, gets) {
  const values = [...url.searchParams].filter(([, v]) => v !== "");
  learned[url.pathname] = [...new Set(gets)].map((g) => values.reduce(
    (s, [k, v]) => s.replace(new RegExp(`(?<=[/=])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[/?&])`, "g"), `{${k}}`), g));
  localStorage.setItem("page-data", JSON.stringify(learned));
}
function predict(url) {
  return (learned[url.pathname] ?? [])
    .map((t) => t.replace(/\{(\w+)\}/g, (m, k) => url.searchParams.get(k) ?? m))
    .filter((p) => !/\{\w+\}/.test(p));
}

// 押す前・押した瞬間の先読み。intent（押した）なら患者のデータも引く。乗せただけなら、URL に患者などの指定が無い画面の分だけ
function warm(href, intent) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.includes(".")) return;
  pageDoc(url.pathname).then((doc) => {
    if (doc === null || pageScript(doc) === undefined) return;
    // 先読みは、移った瞬間に読み込みが切られることがある。壊れたモジュールは開いたときの import（mount）で落ちるので、ここでは拾わない
    import(pageScript(doc)).catch(() => {});
    pageCss(doc).forEach(loadSheet);
    if (intent || url.search === "") predict(url).forEach(prefetch);
  });
}
const targetOf = (el) => el instanceof Element ? el.closest("a[href]:not([target]):not([data-overlay]), [data-href]") : null;
const hrefOf = (el) => el.dataset.href ?? el.getAttribute("href");

// ---------- 切り替え ----------
let current = location.pathname + location.search;
let mounted = null; // 今の画面の { url }

async function navigate(href, { kind, replace = false } = {}) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) {
    location.href = url.href;
    return;
  }
  // 保存していない入力がある画面（処方入力など）は、移る前に確かめる（アプリの窓で。ブラウザの confirm はブラウザ全体を止める）
  const leaving = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leaving);
  if (leaving.defaultPrevented && !(await askConfirm({
    title: "保存していない入力があります", body: "このまま移ると、入力した内容は消えます。", ok: "移る（入力を消す）", cancel: "この画面に残る",
  }))) return;
  warm(url.href, true);
  const doc = await pageDoc(url.pathname);
  if (doc === null || pageScript(doc) === undefined || doc.querySelector(".main") === null) {
    location.href = url.href;
    return;
  }
  show(doc, url, kind ?? "forward", replace ? "replace" : "push");
}

// 左のメニューでは、メニューの並びの向きに上下へ
function tabDirection(url) {
  const links = [...document.querySelectorAll(".sidebar a[href]")].map((a) => new URL(a.href).pathname);
  const from = links.indexOf(location.pathname), to = links.indexOf(url.pathname);
  return from < 0 || to < 0 ? "forward" : to > from ? "tab-down" : "tab-up";
}

function show(doc, url, kind, how) {
  const type = kind === "tab" ? tabDirection(url) : kind;
  let moving = false; // 切り替えの動きが始まったか（準備の間にそろった中身は、浮かび上がらせずにそのまま一緒に動かす）
  const update = async () => {
    window.dispatchEvent(new Event("page-leave")); // 録音などを止める（patient.js）
    scope.abort();
    scope = new AbortController();
    endTour();
    // 画面の CSS を入れ替える（読み込み済みなら一瞬）
    const want = pageCss(doc);
    const links = await Promise.all(want.map(loadSheet));
    for (const [href, l] of sheets) if (!COMMON_CSS.includes(href)) l.media = links.includes(l) ? "all" : "not all";
    // 中身を入れ替える。左のメニュー・重なる窓（とその置き場）・通知は残す
    for (const el of [...document.body.children]) if (!el.matches(".sidebar, dialog.overlay, .overlay-stage, .toasts")) el.remove();
    for (const el of [...doc.cloneNode(true).body.children]) if (!el.matches(".sidebar, script")) document.body.append(document.adoptNode(el));
    document.body.className = doc.body.className;
    document.title = doc.title;
    if (how === "push") history.pushState(null, "", url.href);
    else if (how === "replace") history.replaceState(null, "", url.href);
    current = url.pathname + url.search;
    lastIndex = navigation.currentEntry.index;
    const { ready } = await mount(pageScript(doc), url, () => moving);
    // 同じ画面を開き直すとき（保存した後など）は、新しい内容がそろうまで今の画面を見せたままにする
    await (type === "none" ? ready : Promise.race([ready, new Promise((resolve) => setTimeout(resolve, BUDGET))]));
    moving = type !== "none" && !REDUCED_MOTION.matches;
  };
  if (REDUCED_MOTION.matches) {
    update();
    return;
  }
  document.startViewTransition({ update, types: [type] });
}

// 画面の処理を動かす。返す Promise は「骨組みを描いた」で解け、その中身の Promise（ready）は「データもそろって描き終わった」で解ける
async function mount(src, url, animating) {
  root.classList.remove("page-ready");
  delete root.dataset.shown;
  startPage();
  showCarriedToast(); // 前の画面で保存したことなどの通知は、新しい画面が来たところで出す
  const { default: page } = await import(src);
  const run = page(); // await の手前まで（骨組みを描くところまで）がここで動く
  // 書体（薬の名前の M PLUS Rounded 1c）が届くまで待つ（届く前に出すと、別の書体で描いてから切り替わる）
  const ready = run.then(() => Promise.all([whenIdle(), document.fonts.ready])).then(() => {
    learn(url, stopRecording());
    root.classList.add("page-ready");
    const fades = [];
    if (animating() && !REDUCED_MOTION.matches) {
      for (const el of document.querySelectorAll(".main > :not(.topbar):not(.crumbs):not(.actionbar), .sheet")) {
        fades.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" }).finished);
      }
    }
    if (!document.querySelector(".main")?.contains(document.activeElement)) document.querySelector(".main [autofocus], .sheet [autofocus]")?.focus();
    if (EMBED) toParent({ type: "overlay:ready" }); // 重なる窓は、これを受けて中身を出す（overlay.js）
    // 出そろったことを知らせる（チュートリアルは、これを待ってから部品の位置を測る）。
    // ready はここで解く（切り替えの終わりは待たない。切り替えの準備がこの ready を待つことがあるので、待つと互いに待ち合って止まる）
    Promise.all(fades).then(() => (document.activeViewTransition?.finished ?? Promise.resolve())).then(() => {
      root.dataset.shown = "1";
      document.dispatchEvent(new Event("page-shown"));
      requestIdleCallback(predraw);
      if (!EMBED) requestIdleCallback(warmLinked);
    });
  });
  return { ready };
}

// 閉じている窓を、1コマだけ見えない形（ほぼ透明・画面の奥・押せない）で描き、すぐ元に戻す
// 1つずつ、手の空いた時間に描く（まとめて描くと、その1コマが長くなる）
function predraw() {
  const signal = scope.signal;
  const dialogs = [...document.querySelectorAll("body > dialog:not([open]):not(.overlay)")];
  const next = () => {
    const d = dialogs.shift();
    if (d === undefined || signal.aborted) return;
    if (!d.open) {
      d.style.cssText = "display: block; position: fixed; opacity: .001; pointer-events: none; z-index: -1; transition: none";
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!d.open) {
          d.style.cssText = "display: none; transition: none";
          d.offsetHeight; // 閉じた形をここで確定させてから戻す（戻したときに閉じる動きが走らないように）
        }
        d.style.cssText = "";
      }));
    }
    requestIdleCallback(next);
  };
  next();
}

// ---------- 最初の画面 ----------
let lastIndex = EMBED ? 0 : navigation.currentEntry.index;
// 重なる窓の中では浮かび上がらせない（窓が、そろった中身を出す）
mount(pageScript(document), new URL(location.href), () => !EMBED);

// 重なる窓の中：窓へ移されたとき（overlay.js の overlay:shown）、最後にフォーカスがあった部品へ戻す
if (EMBED) {
  let lastFocus = null;
  nativeListen.call(document, "focusin", (e) => { lastFocus = e.target; });
  nativeListen.call(window, "message", (e) => {
    if (e.origin !== location.origin || e.data?.type !== "overlay:shown" || lastFocus === null || !lastFocus.isConnected) return;
    if (document.activeElement !== lastFocus) lastFocus.focus({ preventScroll: true });
  });
}

if (!EMBED) {
  setNavigator(navigate);
  // リンクを押したら、ページを読み直さずに中身を差し替える
  nativeListen.call(document, "click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
    if (a.target || a.hasAttribute("download") || a.hasAttribute("data-overlay") || new URL(a.href).origin !== location.origin) return;
    e.preventDefault();
    navigate(a.getAttribute("href"), { kind: a.closest(".sidebar") ? "tab" : a.matches(".back-button") || a.closest(".crumbs") ? "back" : "forward" });
  });
  // ブラウザの「戻る」「進む」。重なる窓の開け閉め（同じ URL のまま履歴を積む。overlay.js）はここでは扱わない
  nativeListen.call(window, "popstate", () => {
    if (location.pathname + location.search === current) return;
    const url = new URL(location.href);
    const kind = navigation.currentEntry.index < lastIndex ? "back" : "forward";
    pageDoc(url.pathname).then((doc) => {
      if (doc === null || pageScript(doc) === undefined || doc.querySelector(".main") === null) location.reload();
      else show(doc, url, kind, "none");
    });
  });
  // 先読み：乗せたら画面の部品と一覧のデータ、押したら患者のデータも
  nativeListen.call(document, "pointerover", (e) => { const t = targetOf(e.target); if (t) warm(hrefOf(t), false); });
  nativeListen.call(document, "pointerdown", (e) => { const t = targetOf(e.target); if (t) warm(hrefOf(t), true); }, true);
  nativeListen.call(document, "keydown", (e) => {
    if (e.key !== "Enter") return;
    const t = targetOf(document.activeElement) ?? document.activeElement?.querySelector?.("[aria-selected='true'][data-href]");
    if (t) warm(hrefOf(t), true);
  }, true);
}
// 画面が出たら、手の空いた時間に、この画面から移れる画面（左のメニュー・リンク・押すと移る行）の部品を読んでおく。
// 患者のデータは引かない（warm の intent が false）
function warmLinked() {
  const paths = new Set([...document.querySelectorAll("a[href]:not([target]), [data-href]")].map((el) => new URL(hrefOf(el), location.href).pathname));
  paths.delete(location.pathname); // 今の画面のデータは、今出ているものが最新
  for (const path of paths) warm(path, false);
}
scoped();
