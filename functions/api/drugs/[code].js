// 1品目の薬価の履歴（マスターの変更年月日ごとの薬価）と、どのマスターから入ったか
import { json, HttpError } from "../../../src/server/http.js";

export async function onRequestGet({ params, env }) {
  const drug = await env.DB.prepare(
    "SELECT d.*, pd.name AS pair_name FROM drugs d LEFT JOIN drugs pd ON pd.code = d.pair_code WHERE d.code = ?1",
  ).bind(params.code).first();
  if (!drug) throw new HttpError(404, "薬が見つかりません");
  const history = async (code) => (await env.DB.prepare(
    `SELECT p.valid_from, p.price_sen, p.transitional_until, m.kind, m.published_on, m.file_name
       FROM drug_prices p JOIN master_imports m ON m.id = p.import_id
      WHERE p.drug_code = ?1 ORDER BY p.valid_from`,
  ).bind(code).all()).results.map((r) => ({
    validFrom: r.valid_from,
    priceSen: r.price_sen,
    transitionalUntil: r.transitional_until,
    source: { kind: r.kind, publishedOn: r.published_on, fileName: r.file_name },
  }));
  return json({
    code: drug.code,
    yjCode: drug.yj_code,
    name: drug.name,
    unit: drug.unit,
    generic: drug.generic === 1,
    generalName: drug.general_name,
    sentei: drug.sentei,
    pair: drug.pair_code && { code: drug.pair_code, name: drug.pair_name, history: await history(drug.pair_code) },
    history: await history(drug.code),
  });
}
