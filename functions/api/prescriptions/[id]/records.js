// 来局（処方）への指導記録（SOAP）の追記
import { json, readJson } from "../../../../src/server/http.js";
import { createRecord } from "../../../../src/server/records.js";
import { assertPrescription } from "../../../../src/server/tenant.js";

export async function onRequestPost({ params, request, env, data }) {
  await assertPrescription(env.DB, data.user, params.id);
  return json(await createRecord(env.DB, data.user, params.id, await readJson(request)), 201);
}
