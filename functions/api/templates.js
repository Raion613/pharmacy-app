// 指導記録のテンプレート（一覧・追加）
import { json, readJson } from "../../src/server/http.js";
import { templatesOf, createTemplate } from "../../src/server/records.js";

export async function onRequestGet({ env, data }) {
  return json(await templatesOf(env.DB, data.user.pharmacy_id));
}

export async function onRequestPost({ request, env, data }) {
  return json(await createTemplate(env.DB, data.user, await readJson(request)), 201);
}
