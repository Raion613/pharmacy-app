// 検査結果の用紙の写真から値を読む（固定の結果。保存はしない）
import { json, readJson } from "../../src/server/http.js";
import { readSheet } from "../../src/server/measurements.js";

export async function onRequestPost({ request }) {
  return json(readSheet(await readJson(request)));
}
