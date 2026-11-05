// 服薬指導の会話を文字にして保存（文字起こしは固定の結果）
import { json, readJson } from "../../../../src/server/http.js";
import { createConversation } from "../../../../src/server/records.js";

export async function onRequestPost({ params, request, env, data }) {
  return json(await createConversation(env.DB, data.user, params.id, await readJson(request)), 201);
}
