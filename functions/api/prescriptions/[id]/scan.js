// 調剤監査：バーコード1つを読んで処方と照らし合わせる（保存はしない）
import { json, readJson } from "../../../../src/server/http.js";
import { scan } from "../../../../src/server/inspection.js";
import { assertPrescription } from "../../../../src/server/tenant.js";

export async function onRequestPost({ params, request, env, data }) {
  await assertPrescription(env.DB, data.user, params.id);
  return json(await scan(env.DB, params.id, await readJson(request)));
}
