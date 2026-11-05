// 薬学的管理指導計画書の追記（見直しも新しい行として足す）
import { json, readJson, HttpError } from "../../../../../src/server/http.js";
import { createPlan } from "../../../../../src/server/homecare.js";

export async function onRequestPost({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  return json(await createPlan(env.DB, data.user, id, await readJson(request)), 201);
}
