// 入力中の処方の会計を画面で出すための「その日の事実」（点数・届出・この患者の履歴）。保存時はサーバーが同じものを引き直して計算する
import { json, HttpError, isDate } from "../../src/server/http.js";
import { feeContext } from "../../src/server/fees.js";

export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const date = params.get("date");
  const patientId = Number(params.get("patient"));
  if (!isDate(date)) throw new HttpError(400, "日付が不正です");
  if (!Number.isInteger(patientId)) throw new HttpError(400, "患者が不正です");
  try {
    return json(await feeContext(env.DB, patientId, date));
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    throw new HttpError(400, e.message);
  }
}
