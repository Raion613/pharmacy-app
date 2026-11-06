// 箱を並べる画面の仕組み。画面を 12列 × 12行 の格子に分け、箱（data-box を付けた要素）をその上の長方形に置く。
//   - 「配置を変える」を押すと編集になり、箱の見出しを引っぱると動き、右下の角を引っぱると大きさが変わる（指でもマウスでも）
//   - 「完了」で利用者ごとにサーバーへ保存する。「初期の配置」で画面が決めた配置に戻す
//   - 画面全体はスクロールさせない。箱の中身が入りきらなければ、文字を読める大きさの下限まで小さくして収める。
//     それでも入らないときだけ、その箱の中でスクロールする
import { api, toast } from "./app.js";

const COLS = 12;
const ROWS = 12;
const MIN = { w: 2, h: 2 };
const FONT_MIN = 12; // これより小さい文字にはしない（読めなくなる）

export function setupLayout({ grid, page, defaults, editButton, resetButton }) {
  const boxes = new Map([...grid.querySelectorAll("[data-box]")].map((el) => [el.dataset.box, el]));
  let pos = structuredClone(defaults);
  let editing = false;

  const apply = () => {
    for (const [id, el] of boxes) {
      const p = pos[id];
      el.style.gridColumn = `${p.c} / span ${p.w}`;
      el.style.gridRow = `${p.r} / span ${p.h}`;
    }
    fitAll();
  };

  // 箱ごとに、入りきる一番大きい文字の大きさを探す（data-font-max から 1px ずつ下げる）
  function fit(el) {
    const body = el.querySelector("[data-fit]");
    const max = Number(el.dataset.fontMax);
    for (let size = max; size >= FONT_MIN; size--) {
      body.style.fontSize = `${size}px`;
      if (body.scrollHeight <= body.clientHeight + 1 && body.scrollWidth <= body.clientWidth + 1) return;
    }
  }
  function fitAll() {
    for (const el of boxes.values()) fit(el);
  }

  const overlaps = (id, p) => [...boxes.keys()].some((other) => {
    if (other === id) return false;
    const q = pos[other];
    return p.c < q.c + q.w && q.c < p.c + p.w && p.r < q.r + q.h && q.r < p.r + p.h;
  });

  // 画面上の座標 → 格子の列・行（1から）
  function cellAt(x, y) {
    const rect = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const left = rect.left + parseFloat(style.paddingLeft);
    const top = rect.top + parseFloat(style.paddingTop);
    const width = rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const c = Math.floor(((x - left) / width) * COLS) + 1;
    const r = Math.floor(((y - top) / height) * ROWS) + 1;
    return { c: Math.max(1, Math.min(COLS, c)), r: Math.max(1, Math.min(ROWS, r)) };
  }

  function startDrag(e, id, mode) {
    if (!editing) return;
    e.preventDefault();
    const el = boxes.get(id);
    const before = { ...pos[id] };
    const start = cellAt(e.clientX, e.clientY);
    const offset = { c: start.c - before.c, r: start.r - before.r };
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const at = cellAt(ev.clientX, ev.clientY);
      const p = { ...before };
      if (mode === "move") {
        p.c = Math.max(1, Math.min(COLS - p.w + 1, at.c - offset.c));
        p.r = Math.max(1, Math.min(ROWS - p.h + 1, at.r - offset.r));
      } else {
        p.w = Math.max(MIN.w, Math.min(COLS - p.c + 1, at.c - p.c + 1));
        p.h = Math.max(MIN.h, Math.min(ROWS - p.r + 1, at.r - p.r + 1));
      }
      pos[id] = p;
      el.classList.toggle("blocked", overlaps(id, p));
      el.style.gridColumn = `${p.c} / span ${p.w}`;
      el.style.gridRow = `${p.r} / span ${p.h}`;
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.classList.remove("dragging", "blocked");
      if (overlaps(id, pos[id])) {
        pos[id] = before;
        toast("ほかの箱と重なる所には置けません", "error");
      }
      apply();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end, { once: true });
    el.addEventListener("pointercancel", end, { once: true });
  }

  for (const [id, el] of boxes) {
    el.querySelector(".pbox-head").addEventListener("pointerdown", (e) => startDrag(e, id, "move"));
    const handle = document.createElement("span");
    handle.className = "pbox-resize";
    handle.title = "引っぱって大きさを変える";
    handle.addEventListener("pointerdown", (e) => startDrag(e, id, "resize"));
    el.append(handle);
  }

  function setEditing(on) {
    editing = on;
    grid.classList.toggle("editing", on);
    editButton.textContent = on ? "完了" : "配置を変える";
    editButton.classList.toggle("btn-primary", on);
    resetButton.hidden = !on;
  }

  editButton.addEventListener("click", async () => {
    if (!editing) return setEditing(true);
    setEditing(false);
    await api(`/api/layouts/${page}`, { method: "PUT", body: { layout: pos } });
    toast("配置を保存しました");
  });
  resetButton.addEventListener("click", async () => {
    pos = structuredClone(defaults);
    apply();
    setEditing(false);
    await api(`/api/layouts/${page}`, { method: "DELETE", body: {} });
    toast("初期の配置に戻しました");
  });

  new ResizeObserver(fitAll).observe(grid);

  return {
    // 保存した配置を読む。画面の箱が増減していても、知らない箱は捨て、無い箱は初期の配置を使う
    async load() {
      const { layout } = await api(`/api/layouts/${page}`);
      if (layout) {
        const merged = structuredClone(defaults);
        for (const id of Object.keys(defaults)) if (layout[id]) merged[id] = layout[id];
        pos = merged;
      }
      apply();
    },
    fitAll,
  };
}
