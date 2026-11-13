// お薬手帳の形態を変える
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { updateHandbookKind } from "../../../../src/server/patients.js";
import { assertPatient } from "../../../../src/server/tenant.js";

export async function onRequestPut({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  return json(await updateHandbookKind(env.DB, data.user, id, await readJson(request)));
}
