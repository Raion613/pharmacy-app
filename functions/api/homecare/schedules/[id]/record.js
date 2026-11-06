// 訪問の記録（1回の訪問に1つ）
import { json, readJson, HttpError } from "../../../../../src/server/http.js";
import { createVisitRecord } from "../../../../../src/server/homecare.js";
import { assertSchedule } from "../../../../../src/server/tenant.js";

export async function onRequestPost({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "訪問の予定が見つかりません");
  await assertSchedule(env.DB, data.user, id);
  return json(await createVisitRecord(env.DB, data.user, id, await readJson(request)), 201);
}
