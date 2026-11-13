// 画面の上に重なる窓。1つの業務（来局した患者の対応、今日の受付の進み具合など）を、画面を移らずに1画面で終えるための仕組み。
// 薬歴からは処方入力・領収証・お薬手帳・調剤監査・トレーシングレポート・閲覧記録を、受付状況からは処方入力・調剤監査・薬歴を開く。
// 中身はそれぞれの画面をそのまま読み込む（iframe。URL に embed=1 を付けると、その画面は左のメニューと上の帯を隠す）。
//   閉じ方はどれでも同じ：Esc（窓の中でも外でも）、右上の ×、ブラウザの「戻る」。閉じた窓は「進む」でまた開く
//   窓を開くと履歴に1つ積む（pushState）。「戻る」で積んだ分が外れると popstate が来るので、そこで窓を閉じる
//   iframe の中身を差し替えるとブラウザの履歴にも積まれてしまうので、開くたびに iframe を作り、窓の中で移るときは replace で移る
//   窓の中で保存して元の画面へ戻るとき（例：処方を保存した）は、窓を閉じて元の画面を新しい内容で開き直す
//   画面の中のリンクに data-overlay を付けると、そのリンク先も重なる窓で開く（受付状況から薬歴を開く、など）
//   中の画面は、リンクを押し下げた瞬間（Enter も）に見えない置き場で読み始め、開くときに読み込んだまま窓へ移す（moveBefore は iframe を読み直さない）。
//   そろっていれば、窓は最初のコマから中身の入った形で広がる。0.12秒待ってもそろわなければ先に開き、そろったところで中身を出す
import { reopen } from "./app.js";

const dialog = document.createElement("dialog");
dialog.className = "overlay";
dialog.setAttribute("aria-labelledby", "overlay-title");
dialog.innerHTML = `
  <div class="overlay-head"><span id="overlay-title"></span><span class="spacer"></span>
    <button type="button" class="overlay-close" title="閉じる（Esc）" aria-label="閉じる">×<kbd>Esc</kbd></button></div>`;
// 開く前に中の画面を読んでおく置き場（窓と同じ大きさ・見えない・押せない。router.js は画面を移っても残す）
const stage = document.createElement("div");
stage.className = "overlay-stage";
document.body.append(dialog, stage);
const title = dialog.querySelector("#overlay-title");
const WAIT = 120; // 中の画面を待ってよい長さ（ミリ秒）
let frame = null; // 窓に入っている中の画面 { url, el, ready, whenReady, title }
let staged = null; // 置き場で読んでいる中の画面
let closing = null; // 閉じる動きの間だけ残している中身

const withEmbed = (url) => `${url}${url.includes("?") ? "&" : "?"}embed=1`;

function load(url) {
  const f = { url, el: document.createElement("iframe"), ready: false, title: "" };
  f.whenReady = new Promise((resolve) => { f.resolve = resolve; });
  f.el.title = "開いた画面";
  f.el.addEventListener("load", () => {
    f.title = f.el.contentDocument.title.replace(/ \| .*$/, "");
    if (frame === f) {
      title.textContent = f.title;
      f.el.contentWindow.focus();
    }
  });
  f.el.src = withEmbed(url);
  stage.append(f.el);
  return f;
}
// 押し下げた瞬間に読み始める（同じ URL をもう読んでいれば、それを使う）
function prepare(url) {
  if (staged?.url === url) return;
  staged?.el.remove();
  staged = load(url);
}

let opening = 0;
let returnFocus = null; // 窓を開く前にフォーカスがあった物（閉じたらそこへ戻す）
function show(url) {
  if (!dialog.open) returnFocus = document.activeElement;
  closing?.el.remove();
  closing = null;
  frame?.el.remove();
  if (staged?.url !== url) prepare(url);
  const f = frame = staged;
  staged = null;
  const mine = ++opening;
  const open = () => {
    if (mine !== opening) return;
    dialog.moveBefore(f.el, null); // 読み込んだまま窓へ移す
    f.el.classList.toggle("ready", f.ready);
    title.textContent = f.title;
    if (!dialog.open) dialog.showModal();
    if (f.title !== "") f.el.contentWindow.focus();
    f.el.contentWindow.postMessage({ type: "overlay:shown" }, location.origin); // 窓へ移すとフォーカスが外れることがあるので、中の画面に戻させる（router.js）
  };
  if (f.ready) open();
  else Promise.race([f.whenReady, new Promise((resolve) => setTimeout(resolve, WAIT))]).then(open);
}
function hide() {
  opening++;
  dialog.close();
  // 閉じる動きの間も中の画面は残っているので、フォーカスをそこに残さない（残すと、続けて押したキーが閉じかけの中の画面に届く）
  if (dialog.contains(document.activeElement)) {
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
    else document.activeElement.blur();
  }
  // 閉じる動き（app.css）が終わるまで中身を残す。すぐ開き直したときは show() が先に外す
  const c = closing = frame;
  frame = null;
  if (c !== null) setTimeout(() => { c.el.remove(); if (closing === c) closing = null; }, 620);
}

document.addEventListener("pointerdown", (e) => {
  const a = e.target.closest("a[data-overlay]");
  if (a && e.button === 0) prepare(a.getAttribute("href"));
}, true);
document.addEventListener("keydown", (e) => {
  const a = e.key === "Enter" ? document.activeElement?.closest?.("a[data-overlay]") : null;
  if (a) prepare(a.getAttribute("href"));
}, true);
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-overlay]");
  if (!a || e.defaultPrevented || e.ctrlKey || e.shiftKey || e.metaKey) return;
  e.preventDefault();
  openOverlay(a.getAttribute("href"));
});
// 画面を移ったら、置き場で読んでいた中の画面は捨てる（router.js の page-leave）
window.addEventListener("page-leave", () => {
  staged?.el.remove();
  staged = null;
});

export function openOverlay(url) {
  history.pushState({ overlay: url }, "", location.href);
  show(url);
}

// 閉じるのは「戻る」と同じ。履歴から外れたところで popstate が窓を閉じる
function close() {
  history.back();
}

dialog.querySelector(".overlay-close").addEventListener("click", close);
dialog.addEventListener("cancel", (e) => { // 窓の外にフォーカスがあるときの Esc
  e.preventDefault();
  close();
});
window.addEventListener("popstate", (e) => {
  if (e.state?.overlay) show(e.state.overlay);
  else if (dialog.open) hide();
});

// 窓の中の画面からの頼み（app.js の EMBED を参照）
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  const f = [frame, staged].find((x) => x !== null && e.source === x.el.contentWindow);
  if (f === undefined) return;
  const { type, url, refresh } = e.data;
  if (type === "overlay:ready") {
    f.ready = true;
    f.el.classList.add("ready");
    f.resolve();
    return;
  }
  if (f !== frame) return;
  if (type === "overlay:close") return close();
  if (type !== "overlay:navigate") return;
  // この画面へ戻る：保存した結果を見せるときは開き直し、ただ戻るだけなら窓を閉じる
  if (new URL(url, location.origin).pathname === location.pathname) {
    if (refresh) { // 窓を閉じ、この画面を新しい内容で開き直す（窓を開いたときに積んだ履歴を、その URL で置き換える）
      hide();
      reopen(url);
    } else close();
    return;
  }
  // それ以外（例：保存したトレーシングレポートの印刷）は窓の中で移る
  history.replaceState({ overlay: url }, "", location.href);
  f.el.contentWindow.location.replace(withEmbed(url));
});
