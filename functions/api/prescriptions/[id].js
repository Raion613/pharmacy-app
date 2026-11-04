// 1回の調剤：領収証・明細書と、お薬手帳（紙に貼る内容・電子版のデータ）を作るのに要るもの。患者の情報を返すのでアクセスログを残す
import { json, HttpError } from "../../../src/server/http.js";
import { getPatient } from "../../../src/server/patients.js";
import { prescriptionsOf } from "../../../src/server/prescriptions.js";
import { auditStatement } from "../../../src/server/audit.js";

const PURPOSE = { receipt: "領収証・明細書", handbook: "お薬手帳" };

export async function onRequestGet({ params, request, env, data }) {
  const purpose = PURPOSE[new URL(request.url).searchParams.get("purpose")];
  if (!purpose) throw new HttpError(400, "用途が不正です");
  const row = await env.DB.prepare("SELECT patient_id FROM prescriptions WHERE id = ?1").bind(params.id).first();
  if (!row) throw new HttpError(404, "処方が見つかりません");
  const [patient, prescriptions, pharmacy] = await Promise.all([
    getPatient(env.DB, row.patient_id),
    prescriptionsOf(env.DB, row.patient_id),
    env.DB.prepare("SELECT * FROM pharmacy_profile WHERE id = 1").first(),
  ]);
  await auditStatement(env.DB, data.user.id, "patient.view", row.patient_id, purpose).run();
  return json({
    patient,
    prescription: prescriptions.find((p) => p.id === params.id),
    pharmacy: {
      name: pharmacy.name, prefectureCode: pharmacy.prefecture_code, pharmacyCode: pharmacy.pharmacy_code,
      postalCode: pharmacy.postal_code, address: pharmacy.address, phone: pharmacy.phone,
    },
  });
}
