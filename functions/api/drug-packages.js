// 医薬品コード → 包装のバーコード（GTIN）。調剤監査の画面の「デモ用」のボタンが、手元に薬の箱が無くても読み取りを試せるように使う。
// other=1 のときは、指定した薬以外の包装を1つ返す（取り違えを試すため）
import { json, HttpError } from "../../src/server/http.js";

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const codes = (q.get("codes") ?? "").split(",").filter(Boolean);
  // 1枚の処方は最大300品目（20剤×15品目）。コードは JSON の配列1つで渡す（D1 は1本の SQL に入れられる値が100個まで）
  if (codes.length === 0 || codes.length > 300 || !codes.every((c) => /^6\d{8}$/.test(c))) throw new HttpError(400, "医薬品コードの指定が不正です");
  const list = JSON.stringify(codes);
  // 「（選）」のコードは、対になる普通のコードの箱を返す（drugCode は指定したコードにして返す）
  const { results } = await env.DB.prepare(
    `SELECT p.gtin, d.code AS drug_code, p.package FROM drugs d JOIN drug_packages p ON p.drug_code = COALESCE(d.pair_code, d.code)
      WHERE d.code IN (SELECT value FROM json_each(?1)) ORDER BY d.code, p.gtin`,
  ).bind(list).all();
  const other = q.get("other") === "1"
    ? await env.DB.prepare(
      `SELECT p.gtin, p.drug_code, p.package, d.name FROM drug_packages p JOIN drugs d ON d.code = p.drug_code
        WHERE p.drug_code NOT IN (SELECT value FROM json_each(?1))
          AND p.drug_code NOT IN (SELECT pair_code FROM drugs WHERE code IN (SELECT value FROM json_each(?1)) AND pair_code IS NOT NULL)
        ORDER BY p.gtin LIMIT 1`,
    ).bind(list).first()
    : null;
  return json({ packages: results.map((r) => ({ gtin: r.gtin, drugCode: r.drug_code, package: r.package })), other });
}
