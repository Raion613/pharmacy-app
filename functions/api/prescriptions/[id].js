// 1回の調剤：領収証・明細書・お薬手帳（紙に貼る内容・電子版のデータ）・調剤監査に要るもの。患者の情報を返すのでアクセスログを残す
import { json, HttpError } from "../../../src/server/http.js";
import { getPatient } from "../../../src/server/patients.js";
import { prescriptionsOf } from "../../../src/server/prescriptions.js";
import { auditStatement } from "../../../src/server/audit.js";
import { notesOf } from "../../../src/server/records.js";
import { assertPrescription } from "../../../src/server/tenant.js";
import { jahisText, toShiftJis } from "../../../src/rules/okusuri-techo.js";

const PURPOSE = { receipt: "領収証・明細書", handbook: "お薬手帳", inspection: "調剤監査" };

export async function onRequestGet({ params, request, env, data }) {
  const key = new URL(request.url).searchParams.get("purpose");
  const purpose = PURPOSE[key];
  if (!purpose) throw new HttpError(400, "用途が不正です");
  await assertPrescription(env.DB, data.user, params.id);
  const row = await env.DB.prepare("SELECT patient_id FROM prescriptions WHERE id = ?1").bind(params.id).first();
  if (!row) throw new HttpError(404, "処方が見つかりません");
  const [patient, notes, prescriptions, pharmacy] = await Promise.all([
    getPatient(env.DB, row.patient_id),
    notesOf(env.DB, row.patient_id),
    prescriptionsOf(env.DB, row.patient_id),
    env.DB.prepare("SELECT * FROM pharmacies WHERE id = ?1").bind(data.user.pharmacy_id).first(),
  ]);
  await auditStatement(env.DB, data.user.id, "patient.view", row.patient_id, purpose).run();
  const prescription = prescriptions.find((p) => p.id === params.id);
  const pharmacyJson = {
    name: pharmacy.name, prefectureCode: pharmacy.prefecture_code, pharmacyCode: pharmacy.pharmacy_code,
    postalCode: pharmacy.postal_code, address: pharmacy.address, phone: pharmacy.phone,
  };
  // お薬手帳：電子版のデータ（JAHIS 形式・Shift_JIS）もサーバーで作る。画面はそのバイト列を QR コードにするだけ
  let handbook = null;
  if (key === "handbook") {
    const text = jahisText({ patient, pharmacy: pharmacyJson, prescription });
    handbook = { text, sjisBase64: btoa(String.fromCharCode(...toShiftJis(text))) };
  }
  return json({ patient, notes, prescription, pharmacy: pharmacyJson, handbook });
}
