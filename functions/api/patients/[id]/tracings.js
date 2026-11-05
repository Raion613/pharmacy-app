// 患者のトレーシングレポート（一覧・追記）
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { createTracing, tracingsOf } from "../../../../src/server/tracing.js";

function patientId(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  return id;
}

export async function onRequestGet({ params, env }) {
  return json(await tracingsOf(env.DB, patientId(params)));
}

export async function onRequestPost({ params, request, env, data }) {
  return json(await createTracing(env.DB, data.user, patientId(params), await readJson(request)), 201);
}
