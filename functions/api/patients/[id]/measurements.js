// 検査値・体重の追記
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { createMeasurements } from "../../../../src/server/measurements.js";
import { assertPatient } from "../../../../src/server/tenant.js";

export async function onRequestPost({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  return json(await createMeasurements(env.DB, data.user, id, await readJson(request)), 201);
}
