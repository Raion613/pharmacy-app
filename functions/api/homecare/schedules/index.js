// 訪問の予定を入れる（回数の上限を確かめる）
import { json, readJson } from "../../../../src/server/http.js";
import { createSchedule } from "../../../../src/server/homecare.js";

export async function onRequestPost({ request, env, data }) {
  return json(await createSchedule(env.DB, data.user, await readJson(request)), 201);
}
