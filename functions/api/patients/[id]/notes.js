// 患者メモの追加（1件ずつ分けて、まとめて送る。手で書いたものも、会話から拾って選んだものも）
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { createNotes } from "../../../../src/server/records.js";
import { assertPatient } from "../../../../src/server/tenant.js";

export async function onRequestPost({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  return json(await createNotes(env.DB, data.user, id, await readJson(request)), 201);
}
