// 来局ごとの引き継ぎの確認を付ける・外す
import { json, readJson } from "../../../../src/server/http.js";
import { checkHandover } from "../../../../src/server/prescriptions.js";
import { assertPrescription } from "../../../../src/server/tenant.js";

export async function onRequestPost({ params, request, env, data }) {
  await assertPrescription(env.DB, data.user, params.id);
  return json(await checkHandover(env.DB, data.user, params.id, await readJson(request)), 201);
}
