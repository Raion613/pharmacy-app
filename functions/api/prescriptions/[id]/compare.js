// 改定をまたいで比べる（薬歴の来局カードの計算の内訳）。?date= を省くと比べる日付をサーバーが決める
import { json } from "../../../../src/server/http.js";
import { compareRx } from "../../../../src/server/rx-compare.js";
import { assertPrescription } from "../../../../src/server/tenant.js";

export async function onRequestGet({ params, request, env, data }) {
  await assertPrescription(env.DB, data.user, params.id);
  return json(await compareRx(env.DB, params.id, new URL(request.url).searchParams.get("date")));
}
