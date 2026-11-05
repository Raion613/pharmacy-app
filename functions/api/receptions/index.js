// 受付（その日の一覧・受付する）
import { json, readJson, todayJst } from "../../../src/server/http.js";
import { createReception, receptionsOn } from "../../../src/server/reception.js";

export async function onRequestGet({ request, env }) {
  return json(await receptionsOn(env.DB, new URL(request.url).searchParams.get("date") ?? todayJst()));
}

export async function onRequestPost({ request, env, data }) {
  return json(await createReception(env.DB, data.user, await readJson(request)), 201);
}
