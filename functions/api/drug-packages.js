// 医薬品コード → 包装のバーコード（GTIN）。調剤監査の画面の「デモ用」のボタンが、手元に薬の箱が無くても読み取りを試せるように使う。
// other=1 のときは、指定した薬以外の包装を1つ返す（取り違えを試すため）
import { json, HttpError } from "../../src/server/http.js";

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const codes = (q.get("codes") ?? "").split(",").filter(Boolean);
  if (codes.length === 0 || codes.length > 50 || !codes.every((c) => /^6\d{8}$/.test(c))) throw new HttpError(400, "医薬品コードの指定が不正です");
  const placeholders = codes.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT gtin, drug_code, package FROM drug_packages WHERE drug_code IN (${placeholders}) ORDER BY drug_code, gtin`,
  ).bind(...codes).all();
  const other = q.get("other") === "1"
    ? await env.DB.prepare(
      `SELECT p.gtin, p.drug_code, p.package, d.name FROM drug_packages p JOIN drugs d ON d.code = p.drug_code
        WHERE p.drug_code NOT IN (${placeholders}) ORDER BY p.gtin LIMIT 1`,
    ).bind(...codes).first()
    : null;
  return json({ packages: results.map((r) => ({ gtin: r.gtin, drugCode: r.drug_code, package: r.package })), other });
}
