// 追加した機能の保存処理（本番と同じ SQL を node:sqlite で通す）
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { HttpError } from "../src/server/http.js";
import { createMeasurements, measurementsOf, readSheet } from "../src/server/measurements.js";
import { createConversation, createRecord, createNotes, createTemplate, templatesOf, notesOf } from "../src/server/records.js";
import { prescriptionsOf, createPrescription } from "../src/server/prescriptions.js";
import { createTracing, tracingsOf, getTracing } from "../src/server/tracing.js";
import {
  createFacility, registerHomePatient, createPlan, createSchedule, createVisitRecord, homeOverview, homeDetail, reportsFor,
} from "../src/server/homecare.js";
import { createReception, addStep, receptionsOn } from "../src/server/reception.js";
import { scan, saveInspection, inspectionsOf } from "../src/server/inspection.js";
import { monthlyStats } from "../src/server/stats.js";
import { receiveMessage, replyMessage, messagesOf, threads } from "../src/server/line.js";
import { beginSetup, confirmSetup, startChallenge, finishChallenge, disable, mfaStatus } from "../src/server/mfa.js";
import { hotp, stepOf } from "../src/server/totp.js";
import { todayJst } from "../src/server/http.js";

const FIXTURE = `
INSERT INTO master_imports VALUES (1, 'drug', 'full', '2026-03-19', 'test.csv', 2, 2, '2026-03-19T00:00:00Z', NULL, 'p1');
INSERT INTO drugs (code, yj_code, name, unit, generic, general_name, sentei, pair_code, narcotic, name_key, general_key, attrs_published_on) VALUES
  ('612170710', '2171022F2025', 'ノルバスク錠５ｍｇ', '錠', 0, NULL, 1, NULL, 0, 'ノルバスク錠５ｍｇ', '', '2026-03-19'),
  ('622098501', '2189015F1023', 'アトルバスタチン錠１０ｍｇ「サワイ」', '錠', 1, NULL, 0, NULL, 0, 'アトルバスタチン', '', '2026-03-19');
INSERT INTO drug_prices VALUES ('612170710', '2026-04-01', 1, 1080, NULL), ('622098501', '2026-04-01', 1, 1150, NULL);
INSERT INTO drug_packages VALUES
  ('14987114335002', '612170710', '1032994010202', 'ＰＴＰ 10錠×10'),
  ('14987123456781', '699999999', '9999999999999', 'ＰＴＰ 10錠×10');
INSERT INTO generic_flags VALUES ('2171022F2025', '2026-11-01');
INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'テスト薬局', '13', '9999999', '100-0000', '架空', '000'), (2, '別の薬局', '20', '9999998', '386-0000', '架空', '000');
INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES
  (1, 1, 'test', 'テスト 薬剤師', 'x', 'x', 1), (2, 1, 'b', 'B 薬剤師', 'x', 'x', 1);
INSERT INTO patients (id, pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by) VALUES
  (1, 1, '000001', '架空　太郎', 'カクウ　タロウ', '1945-01-01', 'M', 10, '2026-01-01T00:00:00Z', 1),
  (2, 1, '000002', '架空　花子', 'カクウ　ハナコ', '1970-01-01', 'F', 30, '2026-01-01T00:00:00Z', 1);
INSERT INTO prescriptions (id, patient_id, prescribed_on, dispensed_on, handbook, drug_points, total_points, burden_percent, copay_yen, created_at, created_by)
  VALUES ('rx-1', 1, '2026-10-01', '2026-10-01', 'paper', 14, 100, 10, 100, '2026-10-01T01:00:00Z', 1);
INSERT INTO prescription_rps (id, prescription_id, rp_no, usage, rx_days, days, daily_yen, points_per_day, points) VALUES
  ('rp-1', 'rx-1', 1, '1日1回朝食後', 14, 14, '22.30', 1, 14);
INSERT INTO prescription_items (rp_id, line_no, drug_code, daily_qty_milli, price_sen) VALUES
  ('rp-1', 1, '612170710', 1000, 1080), ('rp-1', 2, '622098501', 1000, 1150);
`;

let db;
beforeEach(() => {
  db = openD1("db/schema.sql");
  db.exec(FIXTURE);
});

const user = { id: 1, pharmacy_id: 1, login_id: "test", display_name: "テスト 薬剤師" };
const pathsOf = async (promise) => {
  try {
    await promise;
    return [];
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.details.map((d) => d.path);
  }
};
const count = async (table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const actions = async () => (await db.prepare("SELECT action FROM access_logs ORDER BY id").all()).results.map((r) => r.action);

test("検査値：空欄は入れず、入力の誤りは項目ごとに返す。用紙の読み取りは保存しない", async () => {
  assert.deepEqual(await pathsOf(createMeasurements(db, user, 1, { measuredOn: "2026-10-01", source: "manual", values: [{ item: "egfr", value: "4.5" }, { item: "x", value: "1" }] })),
    ["values.0.value", "values.1.item"]);
  assert.deepEqual(await pathsOf(createMeasurements(db, user, 1, { measuredOn: "2026-10-01", source: "manual", values: [{ item: "egfr", value: "" }] })), ["values"]);
  const list = await createMeasurements(db, user, 1, { measuredOn: "2026-10-01", source: "photo", values: [{ item: "egfr", value: "48" }, { item: "k", value: "" }, { item: "weight", value: "52.5" }] });
  assert.deepEqual(list.map((m) => [m.item, m.valueMilli, m.source]), [["weight", 52500, "photo"], ["egfr", 48000, "photo"]]);
  assert.deepEqual(await actions(), ["measurement.create"]);
  assert.equal(readSheet({ fileName: "a.jpg", size: 10 }).values.length > 0, true);
  assert.equal(await count("measurements"), 2);
  assert.equal((await measurementsOf(db, 1)).length, 2);
});

test("会話の文字起こし → 下書きから指導記録。会話から拾ったメモはまとめて入れる", async () => {
  assert.deepEqual(await pathsOf(createConversation(db, user, "rx-1", { source: "file", fileName: "", durationSec: 0 })), ["fileName", "durationSec"]);
  const c = await createConversation(db, user, "rx-1", { source: "file", fileName: "指導.webm", durationSec: 95 });
  assert.match(c.transcript, /ノルバスク錠５ｍｇとアトルバスタチン/);
  const rec = await createRecord(db, user, "rx-1", {
    subjective: "胃がもたれる", objective: "", assessment: "", plan: "", leftover: "some", notebook: "used", conversationId: c.id, drafted: true,
  });
  assert.equal(rec.drafted, true);
  // 別の来局の会話は付けられない
  db.exec(`INSERT INTO prescriptions (id, patient_id, prescribed_on, dispensed_on, handbook, drug_points, total_points, burden_percent, copay_yen, created_at, created_by)
           VALUES ('rx-2', 1, '2026-10-15', '2026-10-15', 'paper', 1, 1, 10, 0, '2026-10-15T01:00:00Z', 1);
           INSERT INTO prescription_rps (id, prescription_id, rp_no, usage, rx_days, days, daily_yen, points_per_day, points) VALUES ('rp-2', 'rx-2', 1, '1日1回', 7, 7, '10.80', 1, 7);
           INSERT INTO prescription_items (rp_id, line_no, drug_code, daily_qty_milli, price_sen) VALUES ('rp-2', 1, '612170710', 1000, 1080);`);
  assert.deepEqual(await pathsOf(createRecord(db, user, "rx-2", { plan: "x", leftover: "none", notebook: "used", conversationId: c.id })), ["conversationId"]);
  const [rx] = (await prescriptionsOf(db, 1)).filter((x) => x.id === "rx-1");
  assert.equal(rx.conversations[0].id, c.id);
  assert.equal(rx.records[0].conversationId, c.id);

  assert.deepEqual(await pathsOf(createNotes(db, user, 1, { notes: [{ category: "disease", body: "腰痛", source: "conversation" }, { category: "x", body: "" }] })), ["category", "body"]);
  assert.equal(await count("patient_notes"), 0); // 1件でも誤りがあれば1件も入れない
  await createNotes(db, user, 1, { notes: [{ category: "disease", body: "腰痛", source: "conversation" }, { category: "concomitant", body: "胃腸薬", source: "conversation" }] });
  assert.deepEqual((await notesOf(db, 1)).map((n) => n.source), ["conversation", "conversation"]);
});

test("テンプレート：名前は重ねられない", async () => {
  await createTemplate(db, user, { title: "定期・変更なし", subjective: "変わりない", objective: "", assessment: "", plan: "継続" });
  assert.deepEqual(await pathsOf(createTemplate(db, user, { title: "定期・変更なし", plan: "x" })), ["title"]);
  assert.deepEqual(await pathsOf(createTemplate(db, user, { title: "空" })), ["subjective"]);
  assert.equal((await templatesOf(db, 1)).length, 1);
});

test("トレーシングレポート：服薬状況は必須。来局は同じ患者のものだけ", async () => {
  const body = { institution: "○○内科", department: "内科", doctor: "山田", consent: "agreed", adherence: "昼の飲み忘れがある", prescriptionId: "rx-1" };
  assert.deepEqual(await pathsOf(createTracing(db, user, 1, { ...body, adherence: "", consent: "x" })), ["consent", "adherence"]);
  assert.deepEqual(await pathsOf(createTracing(db, user, 2, body)), ["prescriptionId"]);
  const { id } = await createTracing(db, user, 1, { ...body, nextVisitOn: "2026-11-01", proposal: "朝夕の2回にまとめられないか" });
  const t = await getTracing(db, id);
  assert.equal(t.proposal, "朝夕の2回にまとめられないか");
  assert.equal(t.leftover, "");
  assert.equal((await tracingsOf(db, 1)).length, 1);
});

test("在宅：登録 → 計画書 → 予定（回数の上限）→ 記録 → 報告書", async () => {
  const f = await createFacility(db, user, { name: "ひだまりホーム", address: "架空市1-1", phone: "000-0000" });
  assert.deepEqual(await pathsOf(createFacility(db, user, { name: "ひだまりホーム", address: "a", phone: "b" })), ["name"]);
  await registerHomePatient(db, user, { patientId: 1, facilityId: f.id, institution: "○○内科", doctor: "山田", careManager: "佐々木", intensive: false, startedOn: "2026-10-01" });
  assert.deepEqual(await pathsOf(registerHomePatient(db, user, { patientId: 1, facilityId: null, institution: "a", doctor: "b", intensive: false, startedOn: "2026-10-01" })), ["patientId"]);
  const planBody = { madeOn: "2026-10-01", management: "お薬カレンダー", drugNotes: "Ca拮抗薬：めまい", guidance: "服薬状況の確認", intervalText: "毎週木曜", visitsPerMonth: 5 };
  assert.deepEqual(await pathsOf(createPlan(db, user, 1, planBody)), ["visitsPerMonth"]);
  await createPlan(db, user, 1, { ...planBody, visitsPerMonth: 4 });

  const s1 = await createSchedule(db, user, { patientId: 1, visitOn: "2026-11-05", pharmacistId: 1 });
  assert.deepEqual(await pathsOf(createSchedule(db, user, { patientId: 1, visitOn: "2026-11-06", pharmacistId: 1 })), ["visitOn"]); // 同じ週
  assert.deepEqual(await pathsOf(createSchedule(db, user, { patientId: 1, visitOn: "2026-09-30", pharmacistId: 1 })), ["visitOn"]); // 開始前
  await createSchedule(db, user, { patientId: 1, visitOn: "2026-11-12", pharmacistId: 2 });

  const visit = { storage: "カレンダーで管理", adherence: "良好", leftover: "なし", guidance: "めまいの有無を確認", report: "【服薬状況】良好", shared: "" };
  assert.deepEqual(await pathsOf(createVisitRecord(db, user, s1.id, { ...visit, report: "" })), ["report"]);
  await createVisitRecord(db, user, s1.id, visit);
  assert.deepEqual(await pathsOf(createVisitRecord(db, user, s1.id, visit)), ["storage"]); // 2回は書けない

  const o = await homeOverview(db, 1, "2026-11");
  assert.equal(o.patients[0].plan.reviewDue, "2026-11-01");
  assert.deepEqual(o.schedules.map((s) => [s.visitOn, s.record !== null]), [["2026-11-05", true], ["2026-11-12", false]]);
  assert.equal((await homeDetail(db, 1)).plans.length, 1);
  const reports = await reportsFor(db, 1, { month: "2026-11", facilityId: String(f.id) });
  assert.deepEqual(reports.map((r) => [r.visitOn, r.careManager]), [["2026-11-05", "佐々木"]]);
  assert.equal((await reportsFor(db, 1, { month: "2026-11", facilityId: "home" })).length, 0);
});

test("受付 → 入力 → 監査 → 投薬 → 会計。段階は順番どおりにしか進まない", async () => {
  const r = await createReception(db, user, { patientId: 1 });
  assert.deepEqual(await pathsOf(createReception(db, user, { patientId: 1 })), ["patientId"]); // 会計前の受付がある
  await assert.rejects(addStep(db, user, r.id, "handed"), /監査が済んでいません/);

  // 受付から処方を入力すると「入力済み」
  db.exec("INSERT INTO pharmacy_facility VALUES (1, '2025-04-01', '1', 0, 0, 0, 0, 0, 0, 0)");
  await assert.rejects(createPrescription(db, user, {
    patientId: 2, prescribedOn: todayJst(), dispensedOn: todayJst(), handbook: "paper", inquiries: [], receptionId: r.id,
    rps: [{ usage: "1日1回", rxDays: 7, days: 7, items: [{ drugCode: "612170710", dailyQty: "1" }] }],
  }), (e) => e.details[0].path === "receptionId");
  db.exec(`UPDATE prescriptions SET reception_id = ${r.id} WHERE id = 'rx-1'`);
  db.exec(`INSERT INTO reception_steps VALUES (${r.id}, 'entered', '2026-10-01T01:00:00Z', 1)`);

  // 監査：処方に無い薬・マスターに無い薬・期限切れは保存できない理由にはならないが、全部の薬を読むまでは保存できない
  assert.equal((await scan(db, "rx-1", { raw: "(01)14987114335002(17)991231" })).result, "match");
  assert.equal((await scan(db, "rx-1", { raw: "(01)14987114335002(17)200131" })).result, "expired");
  assert.equal((await scan(db, "rx-1", { raw: "14987123456781" })).result, "wrong");
  assert.equal((await scan(db, "rx-1", { raw: "04912345678904" })).result, "unknown");
  await assert.rejects(scan(db, "rx-1", { raw: "14987114335003" }), (e) => e.status === 422);
  await assert.rejects(saveInspection(db, user, "rx-1", { scans: ["14987114335002"] }), /まだ読んでいない薬があります（1品目）/);
  db.exec("INSERT INTO drug_packages VALUES ('14987188000011', '622098501', '1', 'ＰＴＰ')");
  const saved = await saveInspection(db, user, "rx-1", { scans: ["14987123456781", "14987114335002", "14987188000011"] });
  assert.equal(saved.ng, 1);
  const [ins] = await inspectionsOf(db, "rx-1");
  assert.deepEqual(ins.scans.map((s) => s.result), ["wrong", "match", "match"]);

  await addStep(db, user, r.id, "handed");
  await addStep(db, user, r.id, "paid");
  await assert.rejects(addStep(db, user, r.id, "paid"), /もう済んでいます/);
  await assert.rejects(addStep(db, user, r.id, "audited"), /画面から進められません/);
  const [row] = await receptionsOn(db, 1, todayJst());
  assert.deepEqual(Object.keys(row.steps).sort(), ["audited", "entered", "handed", "paid"]);
  assert.equal(row.prescriptionId, "rx-1");
  await createReception(db, user, { patientId: 1 }); // 会計が済めば次を受け付けられる
});

test("月ごとの集計：処方箋単価と後発医薬品の使用割合（数量ベース）", async () => {
  const [oct, nov] = await monthlyStats(db, 1, { from: "2026-10", to: "2026-11" });
  // ノルバスク（後発品のある先発品）14錠、アトルバスタチン（後発品）14錠 → 50.0%
  assert.deepEqual(oct, {
    month: "2026-10", sheets: 1, unitPriceYen: 1000, drugPoints: 14, totalPoints: 100,
    genericQtyMilli: 14000, originalQtyMilli: 14000, genericPermille: 500,
  });
  assert.equal(nov.sheets, 0);
  assert.equal(nov.genericPermille, null);
  await assert.rejects(monthlyStats(db, 1, { from: "2026-11", to: "2026-10" }), (e) => e.status === 400);
});

test("つながる薬局：受信と返信を残し、患者ごとの最新を一覧にする", async () => {
  await receiveMessage(db, user, { patientId: 1, body: "薬が1日分足りません", sentAt: "2026-10-05T01:00:00Z" });
  await replyMessage(db, user, { patientId: 1, body: "次回お持ちください" });
  await receiveMessage(db, user, { patientId: 2, body: "受け取りは夕方になります", sentAt: "2026-10-04T01:00:00Z" });
  assert.deepEqual(await pathsOf(receiveMessage(db, user, { patientId: 1, body: " " })), ["body"]);
  assert.deepEqual((await messagesOf(db, 1)).map((m) => m.direction), ["in", "out"]);
  assert.deepEqual((await threads(db, 1)).map((t) => t.patientId), [1, 2]);
});

test("多要素認証：設定 → ログインの2段目 → 同じ数字は2回使えない → 無効にする", async () => {
  const req = (cookie) => ({ headers: new Headers(cookie ? { cookie } : {}) });
  assert.deepEqual(await mfaStatus(db, user), { enabled: false });
  await assert.rejects(confirmSetup(db, user, "000000"), /先に/);
  const { secret, uri } = await beginSetup(db, user);
  assert.match(uri, new RegExp(`secret=${secret}`));
  assert.deepEqual(await pathsOf(confirmSetup(db, user, "000000".replace(/0/g, () => "1"))), ["code"]);
  const now = Date.now();
  // 設定で使った区切りの、次の区切りの数字でログインする（設定の数字そのものは使い回せない）
  await confirmSetup(db, user, await hotp(secret, stepOf(now) - 1));
  assert.deepEqual(await mfaStatus(db, user), { enabled: true });

  const setCookie = await startChallenge(db, 1);
  const cookie = setCookie.split(";")[0];
  await assert.rejects(finishChallenge(db, req(null), "123456"), (e) => e.status === 401);
  await assert.rejects(finishChallenge(db, req(cookie), await hotp(secret, stepOf(now) - 1)), /違います/);
  const u = await finishChallenge(db, req(cookie), await hotp(secret, stepOf(now)));
  assert.equal(u.id, 1);
  await assert.rejects(finishChallenge(db, req(cookie), await hotp(secret, stepOf(now) + 1)), /時間が過ぎました/); // 札は使ったら消える
  await disable(db, user, await hotp(secret, stepOf(now) + 1));
  assert.deepEqual(await mfaStatus(db, user), { enabled: false });
  assert.deepEqual((await actions()).filter((a) => a.startsWith("mfa")), ["mfa.enable", "mfa.disable"]);
});

test("監査：「（選）」のコードの処方は、対になる普通のコードの箱で合っているとする（箱は同じ物）", async () => {
  db.exec(`
    INSERT INTO drugs (code, yj_code, name, unit, generic, general_name, sentei, pair_code, narcotic, name_key, general_key, attrs_published_on) VALUES
      ('612220508', '2233002Q1035', 'ムコダインシロップ５％', 'mL', 0, NULL, 1, NULL, 0, 'ムコダイン', '', '2026-03-19'),
      ('672220508', '2233002Q1035', 'ムコダインシロップ５％（選）', 'mL', 0, NULL, 2, '612220508', 0, 'ムコダイン', '', '2026-03-19');
    INSERT INTO drug_packages VALUES ('14987060003734', '612220508', '1', '調剤用 500ＭＬ');
    INSERT INTO prescriptions (id, patient_id, prescribed_on, dispensed_on, handbook, drug_points, total_points, burden_percent, copay_yen, created_at, created_by)
      VALUES ('rx-s', 1, '2026-10-01', '2026-10-01', 'paper', 7, 7, 30, 20, '2026-10-01T01:00:00Z', 1);
    INSERT INTO prescription_rps (id, prescription_id, rp_no, usage, rx_days, days, daily_yen, points_per_day, points) VALUES ('rp-s', 'rx-s', 1, '1日3回', 7, 7, '10.00', 1, 7);
    INSERT INTO prescription_items (rp_id, line_no, drug_code, daily_qty_milli, price_sen) VALUES ('rp-s', 1, '672220508', 10800, 645);`);
  const s = await scan(db, "rx-s", { raw: "(01)14987060003734(17)991231(10)L1" });
  assert.deepEqual([s.result, s.drugCode], ["match", "672220508"]);
  const saved = await saveInspection(db, user, "rx-s", { scans: ["(01)14987060003734(17)991231(10)L1"] });
  assert.equal(saved.ng, 0);
});
