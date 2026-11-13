// 回覧板：「確認した」を押す（1人1回。取り消さない）
import { json, HttpError } from "../../../../src/server/http.js";
import { markRead } from "../../../../src/server/notices.js";

export async function onRequestPost({ params, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "投稿が見つかりません");
  await markRead(env.DB, data.user, id);
  return json({ ok: true });
}
