// 会話から拾った患者メモ（薬剤師が選んだもの）をまとめて追記
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { createNotes } from "../../../../src/server/records.js";

export async function onRequestPost({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  return json(await createNotes(env.DB, data.user, id, await readJson(request)), 201);
}
