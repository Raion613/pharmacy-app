// 調剤監査の記録（一覧・保存）
import { json, readJson } from "../../../../src/server/http.js";
import { saveInspection, inspectionsOf } from "../../../../src/server/inspection.js";

export async function onRequestGet({ params, env }) {
  return json(await inspectionsOf(env.DB, params.id));
}

export async function onRequestPost({ params, request, env, data }) {
  return json(await saveInspection(env.DB, data.user, params.id, await readJson(request)), 201);
}
