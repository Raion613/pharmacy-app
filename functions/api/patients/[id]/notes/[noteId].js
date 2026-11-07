// 患者メモを直す（直す前の内容は残る）
import { json, readJson, HttpError } from "../../../../../src/server/http.js";
import { updateNote } from "../../../../../src/server/records.js";
import { assertPatient } from "../../../../../src/server/tenant.js";

export async function onRequestPut({ params, request, env, data }) {
  const id = Number(params.id);
  const noteId = Number(params.noteId);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  if (!Number.isInteger(noteId)) throw new HttpError(404, "メモが見つかりません");
  await assertPatient(env.DB, data.user, id);
  return json(await updateNote(env.DB, data.user, id, noteId, await readJson(request)));
}
