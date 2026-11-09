// 調剤監査の記録（一覧・保存）
import { json, readJson } from "../../../../src/server/http.js";
import { saveInspection, inspectionsOf } from "../../../../src/server/inspection.js";
import { assertPrescription } from "../../../../src/server/tenant.js";

export async function onRequestGet({ params, env, data }) {
  await assertPrescription(env.DB, data.user, params.id);
  return json(await inspectionsOf(env.DB, params.id));
}

export async function onRequestPost({ params, request, env, data }) {
  await assertPrescription(env.DB, data.user, params.id);
  return json(await saveInspection(env.DB, data.user, params.id, await readJson(request)), 201);
}
