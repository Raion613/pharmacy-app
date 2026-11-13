// 入力中の処方の会計を画面で出すための「その日の事実」（点数・届出・この患者の履歴）。保存時はサーバーが同じものを引き直して計算する
import { json, HttpError, isDate } from "../../src/server/http.js";
import { feeContext } from "../../src/server/fees.js";
import { assertPatient } from "../../src/server/tenant.js";
import { kohiOf, kohiMonthPaid } from "../../src/server/kohi.js";

export async function onRequestGet({ request, env, data }) {
  const params = new URL(request.url).searchParams;
  const date = params.get("date");
  const patientId = Number(params.get("patient"));
  if (!isDate(date)) throw new HttpError(400, "日付が不正です");
  if (!Number.isInteger(patientId)) throw new HttpError(400, "患者が不正です");
  await assertPatient(env.DB, data.user, patientId);
  try {
    const exclude = params.get("exclude"); // 直している処方（自分自身を履歴に数えない）
    const ctx = await feeContext(env.DB, patientId, date, { excludePrescriptionId: exclude });
    // 公費の受給者証と、この薬局でその月に公費ごとに払った額（管理票の累計の初期値）
    return json({ ...ctx, kohi: await kohiOf(env.DB, patientId), kohiMonthPaid: await kohiMonthPaid(env.DB, patientId, date, exclude) });
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    throw new HttpError(400, e.message);
  }
}
