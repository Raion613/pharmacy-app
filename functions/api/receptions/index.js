// 受付（その日の一覧・受付する）
import { json, readJson, todayJst } from "../../../src/server/http.js";
import { createReception, receptionsOn } from "../../../src/server/reception.js";
import { assertBodyPatient } from "../../../src/server/tenant.js";

export async function onRequestGet({ request, env, data }) {
  return json(await receptionsOn(env.DB, data.user.pharmacy_id, new URL(request.url).searchParams.get("date") ?? todayJst()));
}

export async function onRequestPost({ request, env, data }) {
  const body = await readJson(request);
  await assertBodyPatient(env.DB, data.user, body);
  return json(await createReception(env.DB, data.user, body), 201);
}
