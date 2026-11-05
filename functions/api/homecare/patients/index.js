// 在宅で訪問する患者の登録
import { json, readJson } from "../../../../src/server/http.js";
import { registerHomePatient } from "../../../../src/server/homecare.js";

export async function onRequestPost({ request, env, data }) {
  return json(await registerHomePatient(env.DB, data.user, await readJson(request)), 201);
}
