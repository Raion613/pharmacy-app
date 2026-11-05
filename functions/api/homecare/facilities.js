// 在宅の訪問先の施設を追加
import { json, readJson } from "../../../src/server/http.js";
import { createFacility } from "../../../src/server/homecare.js";

export async function onRequestPost({ request, env, data }) {
  return json(await createFacility(env.DB, data.user, await readJson(request)), 201);
}
