// 指導内容の提案。画面が持っている処方・患者の情報を受け取り、規則（src/rules/guidance-suggest.js）で出した提案だけを返す
import { json, readJson } from "../../../src/server/http.js";
import { suggestGuidance } from "../../../src/rules/guidance-suggest.js";

export async function onRequestPost({ request }) {
  const { rx, prevRx, patient, notes, latest, lastRecord } = await readJson(request);
  return json(suggestGuidance({ rx, prevRx, patient, notes, latest, lastRecord }));
}
