import { json, readJson } from "../../../src/server/http.js";
import { searchPatients, createPatient } from "../../../src/server/patients.js";

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams.get("q");
  return json(await searchPatients(env.DB, q));
}

export async function onRequestPost({ request, env, data }) {
  return json(await createPatient(env.DB, data.user, await readJson(request)), 201);
}
