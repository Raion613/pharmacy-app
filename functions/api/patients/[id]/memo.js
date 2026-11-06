// メモ帳（患者ごとの自由なメモ）：書き換える。読むのは患者情報（/api/patients/:id）と一緒
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { saveMemo } from "../../../../src/server/memo.js";
import { assertPatient } from "../../../../src/server/tenant.js";

export async function onRequestPut({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  return json(await saveMemo(env.DB, data.user, id, await readJson(request)));
}
