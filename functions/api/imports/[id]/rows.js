// 取り込み中のマスターに行を足す。本文（JSON の配列）は解釈せず、そのまま SQL に渡す（Worker の CPU 時間を使わない）
import { json, HttpError } from "../../../../src/server/http.js";
import { addRows } from "../../../../src/server/master-import.js";

const MAX_BYTES = 1_500_000; // D1 の1つの値の上限（2MB）より小さく

export async function onRequestPost({ request, params, env, data }) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new HttpError(413, "一度に送る行が多すぎます");
  await addRows(env.DB, data.user.id, params.id, new TextDecoder().decode(body));
  return json({});
}
