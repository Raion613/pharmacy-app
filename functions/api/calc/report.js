// 在宅の報告書の本文。訪問の記録と最新の指導記録を受け取り、決まった形（src/rules/home-visit-rules.js）に並べた文だけを返す
import { json, readJson } from "../../../src/server/http.js";
import { composeReport } from "../../../src/rules/home-visit-rules.js";

export async function onRequestPost({ request }) {
  const { visit, record } = await readJson(request);
  return json({ text: composeReport({ visit, record }) });
}
