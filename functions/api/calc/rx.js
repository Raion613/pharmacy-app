// 処方入力の途中の計算。計算の規則は画面に配らず、ここで計算した結果だけを返す
import { json, readJson } from "../../../src/server/http.js";
import { previewPrescription } from "../../../src/server/rx-preview.js";
import { assertBodyPatient } from "../../../src/server/tenant.js";

export async function onRequestPost({ request, env, data }) {
  const body = await readJson(request);
  await assertBodyPatient(env.DB, data.user, body);
  return json(await previewPrescription(env.DB, body));
}
