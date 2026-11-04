// 薬の検索。品名・一般名（ひらがな・半角でも可）か、医薬品コード・薬価基準収載医薬品コードの先頭で探し、指定日の薬価を付けて返す。
import { json, HttpError, isDate } from "../../../src/server/http.js";
import { PRICE_AT_DATE_JOIN, DRUG_COLUMNS, toDrugJson } from "../../../src/server/prices.js";
import { searchKey } from "../../../public/assets/js/text.js";

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const date = params.get("date");
  if (!isDate(date)) throw new HttpError(400, "日付が不正です");
  const key = searchKey(params.get("q") ?? "");
  if (key === "") return json([]);
  const like = key.replace(/[!%_]/g, (c) => `!${c}`); // 入力の % や _ を、LIKE の記号ではなく文字として扱う

  // 使える薬を先に、その中では先頭一致を先に並べる
  const { results } = await env.DB.prepare(
    `SELECT ${DRUG_COLUMNS}
       FROM drugs d ${PRICE_AT_DATE_JOIN}
      WHERE d.name_key LIKE '%' || ?2 || '%' ESCAPE '!'
         OR d.general_key LIKE '%' || ?2 || '%' ESCAPE '!'
         OR d.code LIKE ?2 || '%' ESCAPE '!'
         OR d.yj_code LIKE ?2 || '%' ESCAPE '!'
      ORDER BY CASE WHEN p.price_sen IS NULL OR p.transitional_until < ?1 THEN 1 ELSE 0 END,
               d.name_key LIKE ?2 || '%' ESCAPE '!' DESC,
               d.name_key, d.sentei
      LIMIT 30`,
  ).bind(date, like).all();
  return json(results.map((row) => toDrugJson(row, date)));
}
