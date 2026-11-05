// つながる薬局：患者ごとの最新のメッセージ
import { json } from "../../../src/server/http.js";
import { threads } from "../../../src/server/line.js";

export async function onRequestGet({ env }) {
  return json(await threads(env.DB));
}
