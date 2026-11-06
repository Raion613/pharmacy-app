// 箱を並べる画面の仕組み。横は 12列、縦は段（行）に分け、箱（data-box を付けた要素）を「何列目から何列ぶん・何段目から何段ぶん」で置く。
//   - 箱の高さは中身で決まる（段の高さは、その段でいちばん背の高い箱に合う）。箱の中ではスクロールさせない。
//     画面に入りきらないときは、箱を並べた領域全体が1本のスクロールで動く
//   - 文字の大きさは変えない（ほかの画面と同じ）
//   - 「配置を変える」を押すと編集になり、箱の見出しを引っぱると動き、右下の角を引っぱると幅と段数が変わる（指でもマウスでも）
//   - 「完了」で利用者ごとにサーバーへ保存する。「初期の配置」で画面が決めた配置に戻す
import { api, toast } from "./app.js";

const COLS = 12;
const ROWS = 12; // 段の数の上限
const MIN = { w: 2, h: 1 };

export function setupLayout({ grid, page, defaults, editButton, resetButton }) {
  const boxes = new Map([...grid.querySelectorAll("[data-box]")].map((el) => [el.dataset.box, el]));
  let pos = structuredClone(defaults);
  let editing = false;

  const place = (el, p) => {
    el.style.gridColumn = `${p.c} / span ${p.w}`;
    el.style.gridRow = `${p.r} / span ${p.h}`;
  };
  const apply = () => {
    for (const [id, el] of boxes) place(el, pos[id]);
  };

  const overlaps = (id, p) => [...boxes.keys()].some((other) => {
    if (other === id) return false;
    const q = pos[other];
    return p.c < q.c + q.w && q.c < p.c + p.w && p.r < q.r + q.h && q.r < p.r + p.h;
  });

  // 画面上の座標 → 列・段（1から）。列は等分、段は高さがまちまちなので、実際の段の高さ（計算済みの値）で数える
  function cellAt(x, y) {
    const rect = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const left = rect.left + parseFloat(style.paddingLeft);
    const width = rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const c = Math.floor(((x - left) / width) * COLS) + 1;
    const gap = parseFloat(style.rowGap);
    const tracks = style.gridTemplateRows.split(" ").map(parseFloat);
    let top = rect.top + parseFloat(style.paddingTop) - grid.scrollTop;
    let r = tracks.length + 1; // いちばん下の段より下なら、新しい段
    for (let i = 0; i < tracks.length; i++) {
      if (y < top + tracks[i] + gap / 2) {
        r = i + 1;
        break;
      }
      top += tracks[i] + gap;
    }
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
      place(el, p);
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
    handle.title = "引っぱって幅と段数を変える";
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
  };
}
