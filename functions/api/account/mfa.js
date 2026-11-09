// 多要素認証の設定（状態・設定を始める・確かめて有効にする・無効にする）
import { json, readJson, HttpError } from "../../../src/server/http.js";
import { mfaStatus, beginSetup, confirmSetup, disable } from "../../../src/server/mfa.js";

export async function onRequestGet({ env, data }) {
  return json(await mfaStatus(env.DB, data.user));
}

export async function onRequestPost({ request, env, data }) {
  const body = await readJson(request);
  if (body.action === "begin") return json(await beginSetup(env.DB, data.user));
  if (body.action === "confirm") await confirmSetup(env.DB, data.user, body.code);
  else if (body.action === "disable") await disable(env.DB, data.user, body.code);
  else throw new HttpError(400, "操作が不正です");
  return json(await mfaStatus(env.DB, data.user));
}
