// 画面の箱の配置（利用者ごと）。iPhone のホーム画面と同じく、箱は「並び順」と「大きさ（何列ぶん・何段ぶん）」だけを持ち、
// 置き場所は並び順に左上から詰めて決まる（横は12列）。画面ごとの表示の選び方（経過を何段の帯にするか等）も一緒に持つ。
// 箱の名前と初期の配置は画面側（public/assets/js/layout-grid.js を使う各画面）が持つ。ここでは形だけを確かめて保存する
//   layout = { boxes: [{ id, w, h }, …], options: { 名前: 整数, … } }
import { HttpError, nowIso } from "./http.js";

export const GRID = { cols: 12, rows: 12 };
const PAGES = new Set(["patient"]);
// 経過の並べ方（0＝折り返し、1・2＝その段数の帯）と、処方の推移の並べ方（0＝横に送る、1＝折り返し）
const OPTIONS = { historyRows: [0, 1, 2], matrixFold: [0, 1] };

function checkPage(page) {
  if (!PAGES.has(page)) throw new HttpError(404, "画面が見つかりません");
}

export function validateLayout(layout) {
  const bad = () => new HttpError(422, "配置が不正です");
  if (typeof layout !== "object" || layout === null || !Array.isArray(layout.boxes)) throw bad();
  const { boxes, options = {} } = layout;
  if (boxes.length === 0 || boxes.length > 20) throw bad();
  const ids = new Set();
  for (const b of boxes) {
    if (typeof b !== "object" || b === null || !/^[a-z]{1,20}$/.test(b.id) || ids.has(b.id)) throw bad();
    ids.add(b.id);
    if (!Number.isInteger(b.w) || !Number.isInteger(b.h) || b.w < 1 || b.w > GRID.cols || b.h < 1 || b.h > GRID.rows) throw bad();
  }
  if (typeof options !== "object" || options === null) throw bad();
  for (const [k, v] of Object.entries(options)) {
    if (!OPTIONS[k]?.includes(v)) throw bad();
  }
  return { boxes: boxes.map((b) => ({ id: b.id, w: b.w, h: b.h })), options: { ...options } };
}

export async function getLayout(db, user, page) {
  checkPage(page);
  const row = await db.prepare("SELECT layout FROM user_layouts WHERE user_id = ?1 AND page = ?2").bind(user.id, page).first();
  return row ? JSON.parse(row.layout) : null;
}

export async function saveLayout(db, user, page, layout) {
  checkPage(page);
  const clean = validateLayout(layout);
  await db.prepare(
    `INSERT INTO user_layouts (user_id, page, layout, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (user_id, page) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
  ).bind(user.id, page, JSON.stringify(clean), nowIso()).run();
  return clean;
}

export async function deleteLayout(db, user, page) {
  checkPage(page);
  await db.prepare("DELETE FROM user_layouts WHERE user_id = ?1 AND page = ?2").bind(user.id, page).run();
}
