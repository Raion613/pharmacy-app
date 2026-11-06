// つながる薬局：薬局から返信する（保存だけ。本物ならつながる薬局の API に送る）
import { json, readJson } from "../../../src/server/http.js";
import { replyMessage } from "../../../src/server/line.js";
import { assertBodyPatient } from "../../../src/server/tenant.js";

export async function onRequestPost({ request, env, data }) {
  const body = await readJson(request);
  await assertBodyPatient(env.DB, data.user, body);
  return json(await replyMessage(env.DB, data.user, body), 201);
}
