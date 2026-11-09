// 指導記録の下書き。会話・処方の変化・検査値・提案を受け取り、規則（src/rules/soap-draft.js）で組み立てた S・O・A・P だけを返す
import { json, readJson } from "../../../src/server/http.js";
import { buildDraft } from "../../../src/rules/soap-draft.js";

export async function onRequestPost({ request }) {
  const { transcript, changes, labs, suggestions, on } = await readJson(request);
  return json(buildDraft({ transcript, changes, labs, suggestions, on }));
}
