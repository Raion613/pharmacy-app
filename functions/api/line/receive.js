// つながる薬局：患者からのメッセージを受け取る（デモ。本物ならつながる薬局のサーバーから届く）
import { json, readJson } from "../../../src/server/http.js";
import { receiveMessage } from "../../../src/server/line.js";
import { assertBodyPatient } from "../../../src/server/tenant.js";

export async function onRequestPost({ request, env, data }) {
  const body = await readJson(request);
  await assertBodyPatient(env.DB, data.user, body);
  return json(await receiveMessage(env.DB, data.user, body), 201);
}
