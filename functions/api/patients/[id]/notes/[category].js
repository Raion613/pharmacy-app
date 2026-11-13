// 患者メモの1つの分類（疾患など）を、書いた欄のとおりに置き換える。追加も修正もこれ（直す前の内容は残る）
import { json, readJson, HttpError } from "../../../../../src/server/http.js";
import { setNote } from "../../../../../src/server/records.js";
import { assertPatient } from "../../../../../src/server/tenant.js";

export async function onRequestPut({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  return json(await setNote(env.DB, data.user, id, params.category, await readJson(request)));
}
