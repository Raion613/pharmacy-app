// 回覧板：一覧（本部からと、この薬局の投稿。新しい順）と、投稿
import { json, readJson } from "../../../src/server/http.js";
import { listNotices, createNotice } from "../../../src/server/notices.js";

export async function onRequestGet({ env, data }) {
  return json(await listNotices(env.DB, data.user));
}

export async function onRequestPost({ request, env, data }) {
  const id = await createNotice(env.DB, data.user, await readJson(request));
  return json({ id }, 201);
}
