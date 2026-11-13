// 受付の記録を消す（処方・監査・指導記録まで）。画面では2回確かめてから呼ぶ
import { json, HttpError } from "../../../src/server/http.js";
import { deleteReception } from "../../../src/server/reception.js";
import { assertReception } from "../../../src/server/tenant.js";

export async function onRequestDelete({ params, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "受付が見つかりません");
  await assertReception(env.DB, data.user, id);
  await deleteReception(env.DB, data.user, id);
  return json({ ok: true });
}
