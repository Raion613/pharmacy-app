// 患者のトレーシングレポート（一覧・追記）
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { createTracing, tracingsOf } from "../../../../src/server/tracing.js";
import { assertPatient } from "../../../../src/server/tenant.js";

async function patientId(params, env, data) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  return id;
}

export async function onRequestGet({ params, env, data }) {
  return json(await tracingsOf(env.DB, await patientId(params, env, data)));
}

export async function onRequestPost({ params, request, env, data }) {
  return json(await createTracing(env.DB, data.user, await patientId(params, env, data), await readJson(request)), 201);
}
