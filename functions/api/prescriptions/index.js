import { json, readJson } from "../../../src/server/http.js";
import { createPrescription } from "../../../src/server/prescriptions.js";
import { assertBodyPatient } from "../../../src/server/tenant.js";

export async function onRequestPost({ request, env, data }) {
  const body = await readJson(request);
  await assertBodyPatient(env.DB, data.user, body);
  return json(await createPrescription(env.DB, data.user, body), 201);
}
