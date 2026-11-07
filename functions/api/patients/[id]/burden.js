// 負担割合を変える
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { updateBurden } from "../../../../src/server/patients.js";
import { assertPatient } from "../../../../src/server/tenant.js";

export async function onRequestPut({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  return json(await updateBurden(env.DB, data.user, id, await readJson(request)));
}
