// 取り込み中のマスター：反映すると何が変わるかの確認と、中止
import { json } from "../../../src/server/http.js";
import { previewImport, discardImport } from "../../../src/server/master-import.js";

export async function onRequestGet({ params, env, data }) {
  return json(await previewImport(env.DB, data.user.id, params.id));
}

export async function onRequestDelete({ params, env, data }) {
  await discardImport(env.DB, data.user.id, params.id);
  return json({});
}
