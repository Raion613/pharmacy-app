// 在宅で訪問する患者の登録
import { json, readJson } from "../../../../src/server/http.js";
import { registerHomePatient } from "../../../../src/server/homecare.js";
import { assertBodyPatient } from "../../../../src/server/tenant.js";

export async function onRequestPost({ request, env, data }) {
  const body = await readJson(request);
  await assertBodyPatient(env.DB, data.user, body);
  return json(await registerHomePatient(env.DB, data.user, body), 201);
}
