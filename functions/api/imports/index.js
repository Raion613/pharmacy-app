// 医薬品マスターの取り込み：一覧と、取り込みの開始。流れは src/server/master-import.js
import { json, readJson } from "../../../src/server/http.js";
import { importHistory, startImport } from "../../../src/server/master-import.js";

export async function onRequestGet({ env }) {
  return json(await importHistory(env.DB));
}

export async function onRequestPost({ request, env, data }) {
  return json({ id: await startImport(env.DB, data.user.id, await readJson(request)) }, 201);
}
