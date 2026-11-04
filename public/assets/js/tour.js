// 画面のチュートリアル。説明する部品だけを明るく残して周りを暗くし、吹き出しで説明する。
// 進む・戻るは吹き出しのボタンだけ（押し間違いで読み飛ばさないため）。Esc で終了。各画面で初回だけ自動で流す。
//
// 手順の書き方：
//   { target: "#q",          … 明るく残す部品（セレクタか、要素を返す関数）。省くと画面全体の説明（中央に出す）
//     title: "…", body: "…", … body は HTML（<kbd> などを使う）
//     placement: "bottom",    … 吹き出しを置きたい向き（入らなければ他の向きに回す）
//     optional: true }        … 部品が無ければ飛ばす（例：薬歴が0件の患者）

const VERSION = "2"; // 説明の中身を大きく変えたら上げる（見た人にも、初回扱いでもう一度流す）
const storageKey = (page) => `tour:${page}`;

let page = null;
let steps = [];
let run = null; // 再生中の状態

export function setTour(pageKey, list) {
  page = pageKey;
  steps = list;
}

// 初めてこの画面を開いたときだけ流す
export function autoStartTour() {
  if (localStorage.getItem(storageKey(page)) === VERSION) return;
  startTour();
}

export function startTour() {
  if (run) return;
  if (steps.length === 0) throw new Error(`チュートリアルが設定されていません: ${page}`);
  const root = buildOverlay();
  run = { root, index: -1, returnFocus: document.activeElement, hole: root.querySelector(".tour-hole"), card: root.querySelector(".tour-card") };
  // 最初は穴を画面の中央で閉じておき、そこから最初の部品へ広がるように見せる。吹き出しは最初の位置に直接置く
  Object.assign(run.hole.style, { left: `${window.innerWidth / 2}px`, top: `${window.innerHeight / 2}px`, width: "0px", height: "0px" });
  run.hole.classList.add("closed");
  run.card.classList.add("instant");
  document.body.append(root);
  window.addEventListener("keydown", onKey, true); // 画面側のショートカット（Alt+N など）より先に受け取る
  window.addEventListener("resize", reposition);
  requestAnimationFrame(() => {
    root.classList.add("open");
    go(0, 1);
  });
}

function buildOverlay() {
  const root = document.createElement("div");
  root.className = "tour";
  root.innerHTML = `
    <div class="tour-hole"></div>
    <section class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      <div class="tour-arrow"></div>
      <header class="tour-head">
        <span class="tour-label">使い方</span>
        <span class="tour-count"></span>
        <button type="button" class="tour-skip">閉じる（Esc）</button>
      </header>
      <div class="tour-progress"><i></i></div>
      <div class="tour-content">
        <h2 id="tour-title"></h2>
        <div id="tour-body" class="tour-body"></div>
      </div>
      <footer class="tour-foot">
        <button type="button" class="tour-prev">戻る</button>
        <button type="button" class="tour-next">次へ</button>
      </footer>
    </section>`;
  root.querySelector(".tour-skip").addEventListener("click", () => finish());
  root.querySelector(".tour-prev").addEventListener("click", () => go(run.index - 1, -1));
  root.querySelector(".tour-next").addEventListener("click", () => go(run.index + 1, 1));
  return root;
}

function resolveTarget(step) {
  if (!step.target) return null;
  return typeof step.target === "function" ? step.target() : document.querySelector(step.target);
}

// index の手順へ。部品が見つからない optional の手順は、進む向きに飛ばす
function go(index, direction) {
  if (index < 0) return;
  if (index >= steps.length) {
    finish();
    return;
  }
  const step = steps[index];
  const target = resolveTarget(step);
  if (step.target && !target) {
    if (!step.optional) throw new Error(`チュートリアルの対象が見つかりません: ${step.target}`);
    go(index + direction, direction);
    return;
  }
  run.index = index;
  run.target = target;
  run.step = step;

  const { card } = run;
  card.querySelector(".tour-count").textContent = `${index + 1} / ${steps.length}`;
  card.querySelector(".tour-progress i").style.width = `${((index + 1) / steps.length) * 100}%`;
  card.querySelector("#tour-title").textContent = step.title;
  card.querySelector("#tour-body").innerHTML = step.body;
  card.querySelector(".tour-prev").disabled = index === 0;
  const last = index === steps.length - 1;
  card.querySelector(".tour-next").textContent = last ? "閉じる" : "次へ";

  // 文章の差し替えを、少し下からふわっと出す
  const content = card.querySelector(".tour-content");
  content.classList.remove("swap");
  void content.offsetWidth;
  content.classList.add("swap");

  if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
  requestAnimationFrame(() => {
    reposition();
    requestAnimationFrame(() => card.classList.remove("instant"));
  });
  card.querySelector(".tour-next").focus({ preventScroll: true });
}

function reposition() {
  if (!run) return;
  const { hole, card, target, step } = run;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  card.classList.toggle("center", !target);
  card.style.width = "";

  if (!target) {
    // 画面全体の説明：穴を中央で閉じて全体を暗くし、吹き出しを真ん中に置く
    Object.assign(hole.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: "0px", height: "0px" });
    hole.classList.add("closed");
    card.dataset.side = "none";
    card.style.left = `${(vw - card.offsetWidth) / 2}px`;
    card.style.top = `${Math.max(16, (vh - card.offsetHeight) / 2)}px`;
    return;
  }

  hole.classList.remove("closed");
  const pad = step.padding ?? 6;
  const r = target.getBoundingClientRect();
  // 画面からはみ出す大きな部品は、見えている範囲だけを囲う（画面の端に接する部品は端まで明るくする）
  const left = Math.max(0, r.left - pad);
  const top = Math.max(0, r.top - pad);
  const right = Math.min(vw, r.right + pad);
  const bottom = Math.min(vh, r.bottom + pad);
  Object.assign(hole.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  placeCard({ left, top, right, bottom, width: right - left, height: bottom - top }, step.placement);
}

// 吹き出しを、部品にかぶらない向きに置く。左右に置くときは空いている幅に合わせて細くし（300pxまで）、
// 上下に置くときは高さが足りなければ幅を広げる。どこにも入らなければ画面の下側に重ねる
const CARD_WIDTH = 380;
const CARD_MIN_WIDTH = 300;

function placeCard(rect, preferred) {
  const { card } = run;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = 12;
  const gap = 16;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const room = {
    bottom: vh - m - (rect.bottom + gap),
    top: rect.top - gap - m,
    right: vw - m - (rect.right + gap),
    left: rect.left - gap - m,
  };

  const order = [preferred, "bottom", "right", "top", "left"].filter(Boolean);
  let side = "overlap";
  search: for (const s of order) {
    // 上下に置くときは、高さが足りなければ幅を広げて背を低くする
    const widths = s === "left" || s === "right" ? [Math.min(CARD_WIDTH, room[s])] : [CARD_WIDTH, 460, 540].filter((w) => w <= vw - 2 * m);
    for (const width of widths) {
      if (width < CARD_MIN_WIDTH) continue;
      card.style.width = `${width}px`;
      const ch = card.offsetHeight;
      if (s === "bottom" || s === "top" ? ch <= room[s] : ch <= vh - 2 * m) {
        side = s;
        break search;
      }
    }
  }
  if (side === "overlap") card.style.width = `${Math.min(CARD_WIDTH, vw - 2 * m)}px`;

  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  let x;
  let y;
  if (side === "bottom" || side === "top") {
    x = clamp(rect.left + rect.width / 2 - cw / 2, m, vw - cw - m);
    y = side === "bottom" ? rect.bottom + gap : rect.top - gap - ch;
  } else if (side === "right" || side === "left") {
    x = side === "right" ? rect.right + gap : rect.left - gap - cw;
    y = clamp(rect.top + rect.height / 2 - ch / 2, m, vh - ch - m);
  } else {
    x = clamp(rect.left + rect.width / 2 - cw / 2, m, vw - cw - m);
    y = vh - ch - m;
  }
  card.dataset.side = side;
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  // 矢印を部品の中心へ向ける
  const arrow = card.querySelector(".tour-arrow");
  arrow.style.left = "";
  arrow.style.top = "";
  if (side === "bottom" || side === "top") arrow.style.left = `${clamp(rect.left + rect.width / 2 - x, 18, cw - 18)}px`;
  else arrow.style.top = `${clamp(rect.top + rect.height / 2 - y, 18, ch - 18)}px`;
}

// 画面側のショートカット（Alt+N など）は止める。進む・戻るはボタンで行う
// （フォーカスしたボタンの Enter・Space はボタンを押したことになる）
function onKey(e) {
  if (!run) return;
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    finish();
  } else if (e.key === "Tab") {
    // フォーカスを吹き出しの中だけで回す
    e.preventDefault();
    const buttons = [...run.card.querySelectorAll("button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement);
    buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  }
}

function finish() {
  if (!run) return;
  localStorage.setItem(storageKey(page), VERSION);
  const { root, returnFocus } = run;
  run = null;
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", reposition);
  root.classList.remove("open");
  root.addEventListener("transitionend", () => root.remove(), { once: true });
  if (returnFocus instanceof HTMLElement) returnFocus.focus({ preventScroll: true });
}

export const tourActive = () => run !== null;
