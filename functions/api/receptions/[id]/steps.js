// 業務を次の段階へ（投薬・会計）
import { json, readJson, HttpError } from "../../../../src/server/http.js";
import { addStep } from "../../../../src/server/reception.js";

export async function onRequestPost({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "受付が見つかりません");
  await addStep(env.DB, data.user, id, (await readJson(request)).step);
  return json({ ok: true }, 201);
}
