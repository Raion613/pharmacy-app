// つながる薬局：患者からのメッセージを受け取る（デモ。本物ならつながる薬局のサーバーから届く）
import { json, readJson } from "../../../src/server/http.js";
import { receiveMessage } from "../../../src/server/line.js";

export async function onRequestPost({ request, env, data }) {
  return json(await receiveMessage(env.DB, data.user, await readJson(request)), 201);
}
