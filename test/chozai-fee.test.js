// 調剤報酬の算定（src/rules/chozai-fee.js）・処方箋と調剤内容の違い・疑義照会・お薬手帳のデータ
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { calcFees, copayYen, eraOf } from "../src/rules/chozai-fee.js";
import { jahisText, toShiftJis } from "../src/rules/okusuri-techo.js";
import { encodeQr } from "../public/assets/js/qr.js";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { loadMasterFile, MASTER_FILES } from "../src/dev/load-master.js";
import { feeContext, feeLookup } from "../src/server/fees.js";
import { createPrescription, validatePrescription } from "../src/server/prescriptions.js";
import { HttpError } from "../src/server/http.js";

// 調剤行為マスター（実ファイル）だけを入れた DB。点数はここから引く
const FEE_MASTERS = MASTER_FILES.filter((f) => /\/m\d{8}\.csv$/.test(f));
let master;
before(async () => {
  master = openD1("db/schema.sql");
  master.exec(`
    INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'テスト薬局', '13', '9999999', '100-0000', '架空', '000'), (2, '別の薬局', '20', '9999998', '386-0000', '架空', '000');
    INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES (1, 1, 't', 'テスト 薬剤師', 'x', 'x', 1);
    INSERT INTO patients (id, pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by)
      VALUES (1, 1, '000001', '架空　太郎', 'カクウ　タロウ', '1960-01-01', 'M', 30, '2026-01-01T00:00:00Z', 1),
             (2, 1, '000002', '架空　花子', 'カクウ　ハナコ', '2023-05-01', 'F', 20, '2026-01-01T00:00:00Z', 1);
    INSERT INTO pharmacy_facility VALUES (1, '2025-04-01', '1', 0, 1, 2, 3, 1, 0, 0), (1, '2026-06-01', '1', 1, 1, 0, 0, 0, 1, 1);`);
  for (const f of FEE_MASTERS) await loadMasterFile(master, f);
});

// その日の点数で算定する。facility・history などは指定したものだけ変える
async function fees(date, overrides = {}) {
  const ctx = await feeContext(master, 1, date);
  return calcFees({
    date,
    facility: ctx.facility,
    ageYears: 66,
    handbook: "paper",
    history: { within3Months: true, done: new Set() },
    rps: [{ days: 14, rxDays: 14, daysChange: null, narcotics: [0] }],
    inquiries: [],
    fee: feeLookup(ctx.fees, date),
    ...overrides,
  });
}
const codes = (r) => r.lines.map((l) => `${l.code}x${l.count}`);
const has = (r, code) => r.lines.some((l) => l.code === code);

test("点数は調剤日の調剤行為マスターから：調剤基本料1 は5月31日まで45点、6月1日から47点", async () => {
  assert.equal((await fees("2026-05-31")).lines[0].points, 45);
  assert.equal((await fees("2026-06-01")).lines[0].points, 47);
  // 名称も日付で変わる（同じコードでも令和8年度は別の意味になる）
  const ctx5 = await feeContext(master, 1, "2026-05-31");
  const ctx6 = await feeContext(master, 1, "2026-06-01");
  assert.equal(ctx5.fees["440012210"].name, "服薬管理指導料（３月以内再度処方箋以外）");
  assert.equal(ctx6.fees["440012210"].name, "服薬管理指導料２（イ）（かかりつけ・３月内以外）");
});

test("令和6年度の調剤管理料は日数で4区分（7日以下・8〜14日・15〜28日・29日以上）", async () => {
  const kanri = async (days) => (await fees("2026-05-14", { rps: [{ days, rxDays: days, daysChange: null, narcotics: [0] }] }))
    .lines.find((l) => l.section === "mgmt").points;
  assert.deepEqual([await kanri(7), await kanri(8), await kanri(14), await kanri(15), await kanri(28), await kanri(29)], [4, 28, 28, 50, 50, 60]);
});

test("令和8年度の調剤管理料は28日以上が60点、それ以外10点", async () => {
  const kanri = async (days) => (await fees("2026-06-01", { rps: [{ days, rxDays: days, daysChange: null, narcotics: [0] }] }))
    .lines.find((l) => l.section === "mgmt").points;
  assert.deepEqual([await kanri(27), await kanri(28)], [10, 60]);
});

test("薬剤調製料・調剤管理料は3剤まで。4剤なら日数の長い3剤を数える", async () => {
  const rp = (days) => ({ days, rxDays: days, daysChange: null, narcotics: [0] });
  const r = await fees("2026-06-01", { rps: [rp(7), rp(28), rp(14), rp(30)] });
  assert.ok(codes(r).includes("420001810x3"));
  assert.ok(codes(r).includes("440023210x2")); // 28日・30日
  assert.ok(codes(r).includes("440023110x1")); // 14日（7日は数えない）
});

test("麻薬は70点、向精神薬などは8点を、その薬がある剤ごとに", async () => {
  const r = await fees("2026-06-01", { rps: [
    { days: 7, rxDays: 7, daysChange: null, narcotics: [1, 5] },
    { days: 7, rxDays: 7, daysChange: null, narcotics: [5] },
    { days: 7, rxDays: 7, daysChange: null, narcotics: [0] },
  ] });
  assert.ok(codes(r).includes("430000270x1")); // 麻薬加算（麻薬と向精神薬が同じ剤なら麻薬だけ）
  assert.ok(codes(r).includes("430000370x1")); // 向精神薬加算
});

test("服薬管理指導料：3月以内の再来局で手帳あり 45点、手帳なし 59点、3月以内でない 59点", async () => {
  const shido = async (date, within3Months, handbook) =>
    (await fees(date, { handbook, history: { within3Months, done: new Set() } })).lines.filter((l) => l.section === "mgmt").at(-1);
  assert.deepEqual((({ code, points }) => [code, points])(await shido("2026-05-14", true, "paper")), ["440012010", 45]);
  assert.deepEqual((({ code, points }) => [code, points])(await shido("2026-05-14", true, "none")), ["440012110", 59]);
  assert.deepEqual((({ code, points }) => [code, points])(await shido("2026-05-14", false, "paper")), ["440012210", 59]);
  assert.deepEqual((({ code, points }) => [code, points])(await shido("2026-06-01", true, "electronic")), ["440025310", 45]);
  assert.deepEqual((({ code, points }) => [code, points])(await shido("2026-06-01", true, "none")), ["440025410", 59]);
  assert.deepEqual((({ code, points }) => [code, points])(await shido("2026-06-01", false, "paper")), ["440026810", 59]);
});

test("乳幼児服薬指導加算：6歳未満で手帳に記載したとき 12点", async () => {
  assert.ok(has(await fees("2026-06-01", { ageYears: 5 }), "440012270"));
  assert.ok(!has(await fees("2026-06-01", { ageYears: 6 }), "440012270"));
  assert.ok(!has(await fees("2026-06-01", { ageYears: 3, handbook: "none" }), "440012270"));
});

test("回数に限りのある項目：月1回・12月に1回・3月に1回は、もう算定していれば入れない", async () => {
  assert.ok(has(await fees("2026-05-14"), "450003270")); // 医療ＤＸ推進体制整備加算３
  assert.ok(!has(await fees("2026-05-14", { history: { within3Months: true, done: new Set(["450003270"]) } }), "450003270"));
  assert.ok(has(await fees("2026-06-01"), "470000210")); // 調剤物価対応料
  assert.ok(!has(await fees("2026-06-01", { history: { within3Months: true, done: new Set(["470000210"]) } }), "470000210"));
});

test("調剤時残薬調整加算（令和8年度）：照会で7日分以上減らしたら 30点。6日分以下は理由を書いたときだけ", async () => {
  const leftover = (rxDays, days, shortReason = null) => fees("2026-06-01", {
    rps: [{ days, rxDays, daysChange: "inquiry", narcotics: [0] }],
    inquiries: [{ kind: "leftover", changed: true, shortReason }],
  });
  assert.ok(has(await leftover(28, 21), "440023870"));
  assert.ok(!has(await leftover(28, 22), "440023870"));
  assert.ok(has(await leftover(28, 22, "高額な抗がん剤のため"), "440023870"));
  // 処方箋に「減量して情報提供」の指示があった減数調剤も同じ
  assert.ok(has(await fees("2026-06-01", { rps: [{ days: 21, rxDays: 28, daysChange: "instruction", narcotics: [0] }] }), "440023870"));
});

test("照会で処方が変わった加算：令和6年度は重複投薬・相互作用等防止加算（残薬以外40点・残薬20点）、令和8年度は薬学的有害事象等防止加算 30点", async () => {
  const r6 = (kinds) => fees("2026-05-14", { inquiries: kinds.map((kind) => ({ kind, changed: true, shortReason: null })) });
  assert.deepEqual((await r6(["leftover"])).lines.filter((l) => l.code.startsWith("4400114") || l.code.startsWith("4400115")).map((l) => l.points), [20]);
  assert.deepEqual((await r6(["adverse", "leftover"])).lines.filter((l) => ["440011470", "440011570"].includes(l.code)).map((l) => l.points), [40]);
  assert.ok(has(await fees("2026-06-01", { inquiries: [{ kind: "adverse", changed: true, shortReason: null }] }), "440024670"));
  assert.ok(!has(await fees("2026-06-01", { inquiries: [{ kind: "adverse", changed: false, shortReason: null }] }), "440024670"));
});

test("一部負担金：合計点数 × 10円 × 負担割合 を10円未満四捨五入", () => {
  assert.equal(copayYen(375, 30), 1130); // 1,125円 → 1,130円
  assert.equal(copayYen(374, 30), 1120); // 1,122円 → 1,120円
  assert.equal(copayYen(257, 10), 260);  // 257円 → 260円
  assert.equal(copayYen(252, 20), 500);  // 504円 → 500円
  assert.throws(() => copayYen(100, 15), RangeError);
});

test("規則の無い日付（令和7年3月以前）は止める", () => {
  assert.throws(() => eraOf("2025-03-31"), RangeError);
  assert.equal(eraOf("2025-04-01"), "r6");
  assert.equal(eraOf("2026-06-01"), "r8");
});

// ---------- 処方箋の記載と調剤内容・疑義照会を保存する ----------

let db;
beforeEach(async () => {
  db = openD1("db/schema.sql");
  db.exec(`
    INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'テスト薬局', '13', '9999999', '100-0000', '架空', '000'), (2, '別の薬局', '20', '9999998', '386-0000', '架空', '000');
    INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES (1, 1, 't', 'テスト', 'x', 'x', 1);
    INSERT INTO patients (id, pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by)
      VALUES (1, 1, '000001', '架空　太郎', 'カクウ　タロウ', '1960-01-01', 'M', 30, '2026-01-01T00:00:00Z', 1);
    INSERT INTO pharmacy_facility VALUES (1, '2025-04-01', '1', 0, 1, 2, 3, 1, 0, 0), (1, '2026-06-01', '1', 1, 1, 0, 0, 0, 1, 1);
    INSERT INTO master_imports VALUES (1, 'drug', 'full', '2026-03-19', 't.csv', 1, 1, '2026-03-19T00:00:00Z', NULL, 'p1');
    INSERT INTO drugs (code, yj_code, name, unit, generic, general_name, sentei, pair_code, narcotic, name_key, general_key, attrs_published_on)
      VALUES ('610000001', '1111111F1011', '試験錠', '錠', 1, '【般】試験錠', 0, NULL, 0, 'A', '', '2026-03-19');
    INSERT INTO drug_prices VALUES ('610000001', '2026-04-01', 1, 1000, NULL);`);
  for (const f of FEE_MASTERS) await loadMasterFile(db, f);
});

const body = (rp, inquiries = []) => ({
  patientId: 1, prescribedOn: "2026-09-17", dispensedOn: "2026-09-17", handbook: "paper", inquiries,
  rps: [{ usage: "1日1回朝食後", items: [{ drugCode: "610000001", dailyQty: "1", rx: null }], ...rp }],
});
const LEFTOVER = { kind: "leftover", content: "7日分残っている。21日分にしてよいか", answer: "21日分で可", changed: true };

test("残薬調整：処方箋28日分を照会で21日分に。日数・照会・加算が残り、薬剤料は21日分", async () => {
  const saved = await createPrescription(db, { id: 1, pharmacy_id: 1 }, body({ rxDays: 28, days: 21, daysChange: "inquiry" }, [LEFTOVER]));
  assert.equal(saved.drugPoints, 21); // 10円 → 1点 × 21日
  const rp = await db.prepare("SELECT rx_days, days, days_change FROM prescription_rps").first();
  assert.deepEqual(rp, { rx_days: 28, days: 21, days_change: "inquiry" });
  const q = await db.prepare("SELECT kind, changed, content FROM inquiries").first();
  assert.deepEqual(q, { kind: "leftover", changed: 1, content: LEFTOVER.content });
  assert.ok(await db.prepare("SELECT 1 FROM prescription_fees WHERE code = '440023870'").first());
  // 合計 = 調剤技術料 + 薬学管理料 + 薬剤料 + その他、一部負担金はその3割
  const rx = await db.prepare("SELECT total_points, copay_yen FROM prescriptions").first();
  const sum = await db.prepare("SELECT SUM(points * count) AS n FROM prescription_fees").first();
  assert.equal(rx.total_points, sum.n + 21);
  assert.equal(rx.copay_yen, copayYen(rx.total_points, 30));
});

test("一般名処方の銘柄選択：処方箋の記載を残し、調剤した薬で計算する", async () => {
  await createPrescription(db, { id: 1, pharmacy_id: 1 }, body({ rxDays: 14, days: 14, daysChange: null,
    items: [{ drugCode: "610000001", dailyQty: "1", rx: { name: "【般】試験錠", dailyQty: "1", reason: "general" } }] }));
  const it = await db.prepare("SELECT drug_code, rx_name, rx_daily_qty_milli, change_reason FROM prescription_items").first();
  assert.deepEqual(it, { drug_code: "610000001", rx_name: "【般】試験錠", rx_daily_qty_milli: 1000, change_reason: "general" });
});

test("日数・照会の決まり：処方箋より多くは調剤できない、減らすには根拠、照会による変更には照会の記録が要る", () => {
  const errorsOf = (b) => {
    try {
      validatePrescription(b, "2026-11-04");
      return [];
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return e.details.map((d) => d.path);
    }
  };
  assert.deepEqual(errorsOf(body({ rxDays: 14, days: 21, daysChange: null })), ["rps.0.days"]);
  assert.deepEqual(errorsOf(body({ rxDays: 28, days: 21, daysChange: null })), ["rps.0.daysChange"]);
  assert.deepEqual(errorsOf(body({ rxDays: 28, days: 21, daysChange: "inquiry" })), ["rps.0.daysChange"]);
  assert.deepEqual(errorsOf(body({ rxDays: 28, days: 21, daysChange: "inquiry" }, [LEFTOVER])), []);
  assert.deepEqual(errorsOf(body({ rxDays: 28, days: 21, daysChange: "instruction" })), []);
  assert.deepEqual(errorsOf(body({ rxDays: 14, days: 14, daysChange: null,
    items: [{ drugCode: "610000001", dailyQty: "1", rx: { name: "", dailyQty: "1", reason: "inquiry" } }] })), ["rps.0.items.0.rx.reason", "rps.0.items.0.rx.name"]);
  assert.deepEqual(errorsOf({ ...body({ rxDays: 14, days: 14, daysChange: null }), handbook: "x" }), ["handbook"]);
  assert.deepEqual(errorsOf(body({ rxDays: 14, days: 14, daysChange: null }, [{ kind: "adverse", content: "", answer: "可", changed: true, shortReason: "x" }])),
    ["inquiries.0.shortReason", "inquiries.0.content"]);
});

// ---------- お薬手帳（電子版のデータ・QR コード） ----------

const SAMPLE = {
  patient: { name: "架空　太郎", kana: "カクウ　タロウ", sex: "M", birthDate: "1960-01-01" },
  pharmacy: { name: "サンプル薬局", prefectureCode: "13", pharmacyCode: "9999999", postalCode: "100-0000", address: "東京都千代田区", phone: "03-0000-0000" },
  prescription: {
    dispensedOn: "2026-10-22", createdBy: "佐藤 薬剤師",
    rps: [{ rpNo: 1, usage: "1日3回毎食後", days: 14, items: [{ name: "ロキソニン錠６０ｍｇ（選）", dailyQtyMilli: 3000, unit: "錠", drugCode: "670098801" }] },
      { rpNo: 2, usage: "1日1回就寝前", days: 7, items: [{ name: "試験散,1%", dailyQtyMilli: 1500, unit: "g", drugCode: "610000001" }] }],
  },
};

test("電子版お薬手帳（JAHIS Ver.2.0）：レコードの並びと書き方", () => {
  assert.equal(jahisText(SAMPLE), [
    "JAHISTC03,1",
    "1,架空　太郎,1,19600101,,,,,,,カクウ　タロウ",
    "5,20261022,1",
    "11,サンプル薬局,13,4,9999999,100-0000,東京都千代田区,03-0000-0000,1",
    "15,佐藤 薬剤師,03-0000-0000,1",
    "201,1,ロキソニン錠６０ｍｇ（選）,3,錠,2,670098801,1",
    "301,1,1日3回毎食後,14,日分,1,1,,1",
    "201,2,試験散，1%,1.5,g,2,610000001,1", // 半角カンマは全角に
    "301,2,1日1回就寝前,7,日分,1,1,,1",
  ].join("\r\n") + "\r\n");
});

test("Shift_JIS への変換：JIS X 0208 の文字は2バイト、半角カナは1バイト、機種依存文字は「■」", () => {
  assert.deepEqual([...toShiftJis("A薬ｱ")], [0x41, 0x96, 0xf2, 0xb1]);
  assert.deepEqual([...toShiftJis("①")], [0x81, 0xa1]); // 丸数字（NEC 特殊文字）は使わない
  assert.equal(new TextDecoder("shift_jis").decode(toShiftJis(jahisText(SAMPLE))), jahisText(SAMPLE));
});

// QR コードの中身は、作った画像を OpenCV（QRCodeDetectorAruco）で読み取り、元のバイト列と一致することを確かめた（型番1〜40）。
// ここでは、その確かめた出力から変わっていないことを見る
test("QR コード：確かめた出力と同じ（型番・セルの並び）", () => {
  const hash = (m) => createHash("sha256").update(m.map((r) => r.map((d) => (d ? 1 : 0)).join("")).join("\n")).digest("hex");
  const a = encodeQr(toShiftJis("HELLO JAHIS 12345"));
  assert.equal((a.length - 17) / 4, 2);
  assert.equal(hash(a), "85d4d9fce43d85549b21099cd6b016d58cb429e9b19e8d1c85c17788c0bd5af0");
  const b = encodeQr(toShiftJis("JAHISTC03,1\r\n201,1,ロキソニン錠６０ｍｇ（選）,3,錠,2,670098801,1\r\n"));
  assert.equal((b.length - 17) / 4, 5);
  assert.equal(hash(b), "f7329479dd1237806a5b41268622de68b62429c5eff46ad0060428106ee1af07");
  assert.throws(() => encodeQr(new Uint8Array(2400)), RangeError);
});
