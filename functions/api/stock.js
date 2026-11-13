// 自分の薬局の、薬ごとの今の在庫（計算上の数）。処方入力で選んだ薬の在庫を出すのに使う。在庫を記録していない薬は null
import { json, HttpError } from "../../src/server/http.js";

export async function onRequestGet({ request, env, data }) {
  const codes = (new URL(request.url).searchParams.get("codes") ?? "").split(",").filter(Boolean);
  if (codes.length > 300) throw new HttpError(400, "一度に引ける薬は300品目までです"); // 1枚の処方の最大（20剤×15品目）
  const { results } = await env.DB.prepare(
    "SELECT drug_code, qty_milli FROM drug_stock WHERE pharmacy_id = ?1 AND drug_code IN (SELECT value FROM json_each(?2))",
  ).bind(data.user.pharmacy_id, JSON.stringify(codes)).all();
  const found = new Map(results.map((r) => [r.drug_code, r.qty_milli]));
  return json(Object.fromEntries(codes.map((c) => [c, found.get(c) ?? null])));
}
