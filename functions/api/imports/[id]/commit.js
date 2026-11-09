// 取り込み中のマスターを、1つのトランザクションで薬価マスタに反映する
import { json } from "../../../../src/server/http.js";
import { commitImport } from "../../../../src/server/master-import.js";

export async function onRequestPost({ params, env, data }) {
  return json(await commitImport(env.DB, data.user.id, params.id));
}
