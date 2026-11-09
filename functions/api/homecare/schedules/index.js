// 訪問の予定を入れる（回数の上限を確かめる）
import { json, readJson } from "../../../../src/server/http.js";
import { createSchedule } from "../../../../src/server/homecare.js";
import { assertBodyPatient } from "../../../../src/server/tenant.js";

export async function onRequestPost({ request, env, data }) {
  const body = await readJson(request);
  await assertBodyPatient(env.DB, data.user, body);
  return json(await createSchedule(env.DB, data.user, body), 201);
}
