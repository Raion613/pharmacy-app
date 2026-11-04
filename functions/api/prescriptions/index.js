import { json, readJson } from "../../../src/server/http.js";
import { createPrescription } from "../../../src/server/prescriptions.js";

export async function onRequestPost({ request, env, data }) {
  return json(await createPrescription(env.DB, data.user, await readJson(request)), 201);
}
