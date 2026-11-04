// 患者メモの追記
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { createNote } from "../../../../src/server/records.js";

export async function onRequestPost({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  return json(await createNote(env.DB, data.user, id, await readJson(request)), 201);
}
