// 薬歴の上に重なる窓。処方入力・領収証・お薬手帳・調剤監査・トレーシングレポート・閲覧記録を、薬歴から離れずに開く。
// 中身はそれぞれの画面をそのまま読み込む（iframe。URL に embed=1 を付けると、その画面は左のメニューと上の帯を隠す）。
//   閉じ方はどれでも同じ：Esc（窓の中でも外でも）、右上の ×、ブラウザの「戻る」。閉じた窓は「進む」でまた開く
//   窓を開くと履歴に1つ積む（pushState）。「戻る」で積んだ分が外れると popstate が来るので、そこで窓を閉じる
//   iframe の中身を差し替えるとブラウザの履歴にも積まれてしまうので、開くたびに iframe を作り直し、窓の中で移るときは replace で移る
//   窓の中で保存して薬歴へ戻るとき（例：処方を保存した）は、窓を閉じて薬歴を新しい内容で開き直す
const dialog = document.createElement("dialog");
dialog.className = "overlay";
dialog.setAttribute("aria-labelledby", "overlay-title");
dialog.innerHTML = `
  <div class="overlay-head"><span id="overlay-title"></span><span class="spacer"></span>
    <button type="button" class="overlay-close" title="閉じる（Esc）" aria-label="閉じる">×<kbd>Esc</kbd></button></div>`;
document.body.append(dialog);
const title = dialog.querySelector("#overlay-title");
let frame = null;

const withEmbed = (url) => `${url}${url.includes("?") ? "&" : "?"}embed=1`;

function show(url) {
  frame?.remove();
  title.textContent = "";
  frame = document.createElement("iframe");
  frame.title = "開いた画面";
  frame.addEventListener("load", () => {
    title.textContent = frame.contentDocument.title.replace(/ \| .*$/, "");
    frame.contentWindow.focus();
  });
  frame.src = withEmbed(url);
  dialog.append(frame);
  if (!dialog.open) dialog.showModal();
}
function hide() {
  dialog.close();
  frame.remove();
  frame = null;
}

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
  if (e.origin !== location.origin || frame === null || e.source !== frame.contentWindow) return;
  const { type, url } = e.data;
  if (type === "overlay:close") return close();
  if (type !== "overlay:navigate") return;
  // 薬歴（この画面）へ戻る：保存した結果を見せるときは開き直し、ただ戻るだけなら窓を閉じる
  if (url.startsWith(location.pathname)) {
    if (new URL(url, location.origin).searchParams.has("saved")) location.replace(url);
    else close();
    return;
  }
  // それ以外（例：保存したトレーシングレポートの印刷）は窓の中で移る
  history.replaceState({ overlay: url }, "", location.href);
  frame.contentWindow.location.replace(withEmbed(url));
});
