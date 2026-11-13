// 1品目の薬価の履歴（マスターの変更年月日ごとの薬価）と、どのマスターから入ったか。自分の薬局の採用薬かどうか
import { json, HttpError, readJson, nowIso } from "../../../src/server/http.js";

export async function onRequestGet({ params, env, data }) {
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
    adopted: await isAdopted(env.DB, data.user.pharmacy_id, drug.code),
    stockMilli: (await env.DB.prepare("SELECT qty_milli FROM drug_stock WHERE pharmacy_id = ?1 AND drug_code = ?2")
      .bind(data.user.pharmacy_id, drug.code).first())?.qty_milli ?? null, // 在庫を記録していない薬は null
  });
}

const isAdopted = async (db, pharmacyId, code) =>
  (await db.prepare("SELECT 1 FROM adopted_drugs WHERE pharmacy_id = ?1 AND drug_code = ?2").bind(pharmacyId, code).first()) !== null;

// 採用薬にする・外す。body：{ adopted: true / false }
export async function onRequestPut({ params, env, data, request }) {
  const body = await readJson(request);
  if (typeof body.adopted !== "boolean") throw new HttpError(400, "adopted は true か false です");
  if (!(await env.DB.prepare("SELECT 1 FROM drugs WHERE code = ?1").bind(params.code).first())) throw new HttpError(404, "薬が見つかりません");
  const pharmacyId = data.user.pharmacy_id;
  await (body.adopted
    ? env.DB.prepare("INSERT OR IGNORE INTO adopted_drugs (pharmacy_id, drug_code, adopted_at, adopted_by) VALUES (?1, ?2, ?3, ?4)")
      .bind(pharmacyId, params.code, nowIso(), data.user.id)
    : env.DB.prepare("DELETE FROM adopted_drugs WHERE pharmacy_id = ?1 AND drug_code = ?2").bind(pharmacyId, params.code)).run();
  return json({ adopted: body.adopted });
}
