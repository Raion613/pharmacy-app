// 画面とサーバーで共通に使う規則（小児の分量・バーコード・多要素認証・在宅の回数・指導の提案・SOAP の下書き・検査値）
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPediatricDose, mgPerGram, timesPerDay } from "../public/assets/js/pediatric-dose.js";
import { parseGs1, gtinCheckDigitOk, Gs1Error } from "../public/assets/js/gs1.js";
import { hotp, verifyTotp, base32Encode, base32Decode, otpauthUri } from "../src/server/totp.js";
import { checkVisit, weekStart, planReviewDue, composeReport } from "../public/assets/js/home-visit-rules.js";
import { suggestGuidance, shortName } from "../public/assets/js/guidance-suggest.js";
import { buildDraft, extractNotes, parseTranscript } from "../public/assets/js/soap-draft.js";
import { parseLabValue, formatLabValue, latestByItem } from "../public/assets/js/lab-items.js";

// ---------- 小児の分量 ----------

const calonal20 = { yjCode: "1141007C1075", name: "カロナール細粒２０％", unit: "g" };
const widecillin20 = { yjCode: "6131001C2100", name: "ワイドシリン細粒２０％", unit: "g" };
const mucodyne = { yjCode: "2233002R2029", name: "ムコダインＤＳ５０％", unit: "g" };
const clarith = { yjCode: "6149003R1143", name: "クラリスドライシロップ１０％小児用", unit: "g" };

test("含量と回数を品名・用法から読む", () => {
  assert.equal(mgPerGram("カロナール細粒２０％"), 200);
  assert.equal(mgPerGram("小児用ムコソルバンＤＳ１．５％"), 15);
  assert.equal(mgPerGram("ノルバスク錠５ｍｇ"), null);
  assert.equal(timesPerDay("1日3回毎食後"), 3);
  assert.equal(timesPerDay("１日２回朝夕食後"), 2);
  assert.equal(timesPerDay("疼痛時"), null);
});

test("アセトアミノフェン：1回10〜15mg/kg、1日60mg/kgまで", () => {
  const w18 = 18000;
  // 1日 2.7g × 200mg = 540mg、3回 → 1回 180mg = 10mg/kg（下限ちょうど）
  assert.equal(checkPediatricDose({ drug: calonal20, dailyQtyMilli: 2700, usage: "1日3回毎食後", weightMilli: w18 }).status, "ok");
  // 1日 2.4g → 1回 160mg = 8.9mg/kg
  assert.equal(checkPediatricDose({ drug: calonal20, dailyQtyMilli: 2400, usage: "1日3回毎食後", weightMilli: w18 }).status, "low");
  // 1日 4.2g → 1回 280mg = 15.6mg/kg
  assert.equal(checkPediatricDose({ drug: calonal20, dailyQtyMilli: 4200, usage: "1日3回毎食後", weightMilli: w18 }).status, "high");
  // 1日 5.5g → 1100mg = 61.1mg/kg/日（上限超え）
  const over = checkPediatricDose({ drug: calonal20, dailyQtyMilli: 5500, usage: "1日4回", weightMilli: w18 });
  assert.equal(over.status, "over");
  // 体重が重い子：1日の量が成人の上限 4000mg を超える（70kg、1回15mg/kg × 4回 = 4200mg）
  assert.equal(checkPediatricDose({ drug: calonal20, dailyQtyMilli: 21000, usage: "1日4回", weightMilli: 70000 }).status, "over");
  // 回数が読めない・体重が無い
  assert.equal(checkPediatricDose({ drug: calonal20, dailyQtyMilli: 2700, usage: "発熱時", weightMilli: w18 }).status, "check");
  assert.equal(checkPediatricDose({ drug: calonal20, dailyQtyMilli: 2700, usage: "1日3回", weightMilli: null }).status, "check");
});

test("アモキシシリン：1日20〜40mg/kg、90mg/kg まで", () => {
  // 20kg、ワイドシリン細粒20% 1日 3g = 600mg = 30mg/kg
  assert.equal(checkPediatricDose({ drug: widecillin20, dailyQtyMilli: 3000, usage: "1日3回", weightMilli: 20000 }).status, "ok");
  // 1日 8g = 1600mg = 80mg/kg（通常量より多いが上限内）
  assert.equal(checkPediatricDose({ drug: widecillin20, dailyQtyMilli: 8000, usage: "1日3回", weightMilli: 20000 }).status, "high");
  // 1日 9.5g = 1900mg = 95mg/kg
  assert.equal(checkPediatricDose({ drug: widecillin20, dailyQtyMilli: 9500, usage: "1日3回", weightMilli: 20000 }).status, "over");
});

test("カルボシステインは標準量 30mg/kg/日、クラリスロマイシンは 10〜15mg/kg/日", () => {
  // 15kg、ムコダインDS50% 1日 0.9g = 450mg = 30mg/kg
  assert.equal(checkPediatricDose({ drug: mucodyne, dailyQtyMilli: 900, usage: "1日3回", weightMilli: 15000 }).status, "ok");
  assert.match(checkPediatricDose({ drug: mucodyne, dailyQtyMilli: 1200, usage: "1日3回", weightMilli: 15000 }).message, /標準量/);
  // 15kg、クラリスDS10% 1日 2g = 200mg = 13.3mg/kg
  assert.equal(checkPediatricDose({ drug: clarith, dailyQtyMilli: 2000, usage: "1日2回", weightMilli: 15000 }).status, "ok");
  // 表に無い成分は対象外
  assert.equal(checkPediatricDose({ drug: { yjCode: "2171022F2025", name: "ノルバスク錠５ｍｇ", unit: "錠" }, dailyQtyMilli: 1000, usage: "1日1回", weightMilli: 15000 }), null);
});

// ---------- バーコード ----------

test("GTIN のチェックデジット", () => {
  assert.ok(gtinCheckDigitOk("14987114335002")); // ノルバスク錠５ｍｇ ＰＴＰ 10錠×10（HOTコードマスター）
  assert.ok(!gtinCheckDigitOk("14987114335003"));
});

test("GS1 の文字列を3通りの形で読む", () => {
  const want = { gtin: "14987114335002", expiry: "2028-03-31", lot: "A123", serial: null };
  assert.deepEqual(parseGs1("(01)14987114335002(17)280331(10)A123"), want);
  assert.deepEqual(parseGs1("011498711433500217280331 10A123".replace(" ", "")), want);
  assert.deepEqual(parseGs1("]C1011498711433500210A123\u001d17280331"), want);
  assert.deepEqual(parseGs1("14987114335002"), { gtin: "14987114335002", expiry: null, lot: null, serial: null });
  // 日が 00 は月末
  assert.equal(parseGs1("(01)14987114335002(17)280200").expiry, "2028-02-29");
  assert.throws(() => parseGs1("(01)14987114335003"), Gs1Error);
  assert.throws(() => parseGs1("(17)280331"), Gs1Error);
  assert.throws(() => parseGs1("(01)14987114335002(17)281332"), Gs1Error);
});

// ---------- 多要素認証 ----------

test("TOTP は RFC 6238 の試験値と同じ数字を出す", async () => {
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual([...base32Decode(secret)], [...new TextEncoder().encode("12345678901234567890")]);
  // RFC 6238 付録 B（SHA1）。8桁の値の下6桁
  assert.equal(await hotp(secret, Math.floor(59 / 30)), "287082");
  assert.equal(await hotp(secret, Math.floor(1111111109 / 30)), "081804");
  assert.equal(await hotp(secret, Math.floor(1234567890 / 30)), "005924");
  // ±30秒まで受け付け、使った区切り以前は受け付けない
  const now = 1234567890 * 1000;
  assert.equal(await verifyTotp(secret, "005924", { now }), Math.floor(1234567890 / 30));
  assert.equal(await verifyTotp(secret, "005924", { now: now + 30000 }), Math.floor(1234567890 / 30));
  assert.equal(await verifyTotp(secret, "005924", { now: now + 60000 }), null);
  assert.equal(await verifyTotp(secret, "005924", { now, lastStep: Math.floor(1234567890 / 30) }), null);
  assert.equal(await verifyTotp(secret, "12345", { now }), null);
  assert.match(otpauthUri({ secret, account: "demo", issuer: "薬局" }), /^otpauth:\/\/totp\/%E8%96%AC%E5%B1%80%3Ademo\?secret=GEZ/);
});

// ---------- 在宅の回数 ----------

test("在宅の訪問：月4回・週1回（重い患者は月8回・週2回）、薬剤師1人週40回", () => {
  assert.equal(weekStart("2026-11-05"), "2026-11-01"); // 木曜 → その週の日曜
  const base = { intensive: false, pharmacistDates: [] };
  assert.deepEqual(checkVisit({ ...base, date: "2026-11-12", patientDates: ["2026-11-05"] }), []);
  assert.equal(checkVisit({ ...base, date: "2026-11-06", patientDates: ["2026-11-05"] }).length, 1); // 同じ週
  assert.equal(checkVisit({ ...base, date: "2026-11-30", patientDates: ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"] }).length, 1);
  assert.deepEqual(checkVisit({ intensive: true, pharmacistDates: [], date: "2026-11-06", patientDates: ["2026-11-05"] }), []);
  const busy = Array.from({ length: 40 }, () => "2026-11-04");
  assert.equal(checkVisit({ ...base, pharmacistDates: busy, date: "2026-11-05", patientDates: [] }).length, 1);
  assert.equal(planReviewDue("2026-10-15"), "2026-11-15");
  assert.equal(planReviewDue("2026-01-31"), "2026-02-28");
  assert.match(composeReport({ visit: { adherence: "良好", leftover: "なし", storage: "カレンダー", guidance: "説明" }, record: { subjective: "", assessment: "", plan: "次回確認" } }), /【今後の方針・提案】次回確認/);
});

// ---------- 指導の提案・下書き ----------

const item = (drugCode, yjCode, name, generalName = null) => ({ drugCode, yjCode, name, generalName });
const atorva = item("622098501", "2189015F1023", "アトルバスタチン錠１０ｍｇ「サワイ」", "【般】アトルバスタチン錠１０ｍｇ");
const norvasc = item("612170710", "2171022F2025", "ノルバスク錠５ｍｇ");
const magmitt = item("610463198", "2344009F1046", "マグミット錠３３０ｍｇ");
const loxonin = item("620098801", "1149019F1560", "ロキソニン錠６０ｍｇ");
const rxOf = (dispensedOn, ...items) => ({ dispensedOn, rps: [{ items }] });

test("指導の提案：新しい薬・中止した薬・腎機能・アレルギー歴・前回の留意点", () => {
  const s = suggestGuidance({
    rx: rxOf("2026-11-01", norvasc, atorva, magmitt),
    prevRx: rxOf("2026-10-01", norvasc, loxonin),
    patient: { birthDate: "1945-03-08" },
    notes: [{ id: 1, category: "allergy", body: "ロキソニンで発疹" }],
    latest: { egfr: { valueMilli: 48000, measuredOn: "2026-10-20" } },
    lastRecord: { on: "2026-10-01", plan: "便通を確認", leftover: "some" },
  });
  const keys = s.map((x) => x.key);
  assert.ok(keys.includes("drug:622098501"));
  assert.match(s.find((x) => x.key === "drug:622098501").plan, /横紋筋融解症/); // 一般名でスタチンと分かる
  assert.match(s.find((x) => x.key === "drug:622098501").title, /今回から/);
  assert.ok(keys.includes("stop:620098801"));
  assert.ok(keys.includes("renal:610463198"));
  assert.ok(keys.includes("last-plan") && keys.includes("last-leftover"));
  assert.ok(!keys.some((k) => k.startsWith("allergy:"))); // 今回ロキソニンは出ていない
  const withAllergy = suggestGuidance({
    rx: rxOf("2026-11-01", loxonin), prevRx: null, patient: { birthDate: "1990-01-01" },
    notes: [{ id: 1, category: "allergy", body: "ロキソニンで発疹" }], latest: {}, lastRecord: null,
  });
  assert.ok(withAllergy.some((x) => x.key === "allergy:1:620098801"));
  // eGFR が古い（180日より前）なら腎機能の提案は出さない
  const old = suggestGuidance({
    rx: rxOf("2026-11-01", magmitt), prevRx: null, patient: { birthDate: "1945-03-08" }, notes: [],
    latest: { egfr: { valueMilli: 48000, measuredOn: "2026-01-01" } }, lastRecord: null,
  });
  assert.ok(!old.some((x) => x.kind === "patient"));
  assert.equal(shortName("アトルバスタチン錠１０ｍｇ「サワイ」"), "アトルバスタチン");
  assert.equal(shortName("ロキソニン錠６０ｍｇ（選）"), "ロキソニン");
});

const TALK = [
  "薬剤師：今日はマグミット錠が出ています。",
  "患者：お通じは毎日あります。昼の分が3回分残っています。",
  "家族：ドラッグストアで買った胃腸薬を飲ませています。",
  "患者：昔、ペニシリンで発疹が出ました。アレルギーはそれだけです。",
  "患者：お酒は飲んでいません。",
  "患者：去年から整形外科で腰痛の治療をしています。",
].join("\n");

test("会話から下書きを組み立て、患者メモの候補を拾う", () => {
  assert.equal(parseTranscript(TALK)[0].speaker, "薬剤師");
  const d = buildDraft({
    transcript: TALK, changes: ["−中止 ロキソニン錠６０ｍｇ"],
    labs: [{ label: "eGFR", text: "48", measuredOn: "2026-10-20" }, { label: "LDL", text: "120", measuredOn: "2026-01-01" }],
    suggestions: [{ assessment: "腎機能に注意", plan: "Mg に注意" }, { assessment: null, plan: "Mg に注意" }],
    on: "2026-11-01",
  });
  assert.match(d.subjective, /^お通じは毎日あります。（家族）ドラッグストアで/);
  assert.doesNotMatch(d.subjective, /残っています/); // 残薬の話は O に回す
  assert.match(d.objective, /処方：−中止 ロキソニン/);
  assert.match(d.objective, /eGFR 48（10\/20）/);
  assert.doesNotMatch(d.objective, /LDL/); // 90日より前の検査値は入れない
  assert.match(d.objective, /残薬：「昼の分が3回分残っています。」/);
  assert.equal(d.assessment, "腎機能に注意。");
  assert.equal(d.plan, "Mg に注意。");
  assert.equal(d.leftover, "some");

  const notes = extractNotes(TALK);
  assert.deepEqual(notes.map((n) => n.category), ["concomitant", "allergy", "allergy", "disease"]);
  assert.match(notes[0].body, /^（家族より）ドラッグストア/);
  // 否定の文（お酒は飲んでいません）は拾わない
  assert.ok(!notes.some((n) => n.category === "lifestyle"));
});

// ---------- 検査値 ----------

test("検査値は1000倍の整数で持つ", () => {
  assert.equal(parseLabValue("egfr", "48"), 48000);
  assert.equal(parseLabValue("ptinr", "1.25"), 1250);
  assert.equal(parseLabValue("weight", "１８．５"), 18500);
  assert.throws(() => parseLabValue("egfr", "48.5"), RangeError);
  assert.throws(() => parseLabValue("k", "abc"), RangeError);
  assert.equal(formatLabValue("ptinr", 1250), "1.25");
  assert.equal(formatLabValue("weight", 18000), "18.0");
  const latest = latestByItem([
    { item: "egfr", valueMilli: 50000, measuredOn: "2026-06-01" },
    { item: "egfr", valueMilli: 48000, measuredOn: "2026-09-01" },
    { item: "egfr", valueMilli: 40000, measuredOn: "2026-12-01" },
  ], "2026-11-01");
  assert.deepEqual(latest.egfr, { valueMilli: 48000, measuredOn: "2026-09-01" });
});
