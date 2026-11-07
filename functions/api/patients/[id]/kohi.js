// 公費（受給者証）の登録
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { createKohi } from "../../../../src/server/kohi.js";
import { assertPatient } from "../../../../src/server/tenant.js";

export async function onRequestPost({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  return json(await createKohi(env.DB, data.user, id, await readJson(request)), 201);
}
