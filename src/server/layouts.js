// 画面の箱の配置（利用者ごと）。画面は 12列 × 12行 の格子で、箱はその上の長方形（列・行・幅・高さ）。
// 箱の名前と初期の配置は画面側（public/assets/js/layout-grid.js を使う各画面）が持つ。ここでは形だけを確かめて保存する
import { HttpError, nowIso } from "./http.js";

export const GRID = { cols: 12, rows: 12 };
const PAGES = new Set(["patient"]);

function checkPage(page) {
  if (!PAGES.has(page)) throw new HttpError(404, "画面が見つかりません");
}

export function validateLayout(layout) {
  const bad = () => new HttpError(422, "配置が不正です");
  if (typeof layout !== "object" || layout === null || Array.isArray(layout)) throw bad();
  const entries = Object.entries(layout);
  if (entries.length === 0 || entries.length > 20) throw bad();
  for (const [id, b] of entries) {
    if (!/^[a-z]{1,20}$/.test(id)) throw bad();
    const { c, r, w, h } = b ?? {};
    if (![c, r, w, h].every(Number.isInteger)) throw bad();
    if (c < 1 || r < 1 || w < 1 || h < 1 || c + w - 1 > GRID.cols || r + h - 1 > GRID.rows) throw bad();
  }
  return Object.fromEntries(entries.map(([id, b]) => [id, { c: b.c, r: b.r, w: b.w, h: b.h }]));
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
