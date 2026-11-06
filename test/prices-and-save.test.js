// 「この日付時点の薬価」の SQL と、処方の保存（トランザクション）を、本番と同じコードで確かめる。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { pricesAt } from "../src/server/prices.js";
import { createPrescription, validatePrescription } from "../src/server/prescriptions.js";
import { HttpError } from "../src/server/http.js";
import { loadMasterFile, MASTER_FILES } from "../src/dev/load-master.js";

const FIXTURE = `
INSERT INTO master_imports VALUES (1, 'drug', 'full', '2025-03-18', 'old.csv', 5, 5, '2025-03-18T00:00:00Z', NULL, 'p1'),
                                  (2, 'drug', 'full', '2026-03-19', 'new.csv', 6, 6, '2026-03-19T00:00:00Z', NULL, 'p2');
INSERT INTO drugs (code, yj_code, name, unit, generic, general_name, sentei, pair_code, narcotic, name_key, general_key, attrs_published_on) VALUES
  ('610000001', '1111111F1011', '改定で上がる錠', '錠', 0, NULL, 0, NULL, 0, 'A', '', '2026-03-19'),
  ('610000002', '2222222F1011', '年度途中に収載された錠', '錠', 0, NULL, 0, NULL, 0, 'B', '', '2026-03-19'),
  ('610000003', '3333333F1011', '改定で廃止された錠', '錠', 0, NULL, 0, NULL, 0, 'C', '', '2026-03-19'),
  ('610000004', '4444444F1011', '経過措置の錠', '錠', 0, NULL, 0, NULL, 0, 'D', '', '2026-03-19'),
  ('610000005', '5555555B1011', '1g単位の散', 'g', 0, NULL, 0, NULL, 0, 'E', '', '2026-03-19'),
  ('620000006', '6666666F1011', '長期収載品の錠', '錠', 0, NULL, 1, NULL, 0, 'F', '', '2026-03-19'),
  ('670000006', '6666666F1011', '長期収載品の錠（選）', '錠', 0, NULL, 2, '620000006', 0, 'F', '', '2026-03-19');
INSERT INTO drug_prices (drug_code, valid_from, import_id, price_sen, transitional_until) VALUES
  ('610000001', '2025-04-01', 1, 1500, NULL),
  ('610000001', '2026-04-01', 2, 1530, NULL),
  ('610000002', '2026-06-12', 2, 2000, NULL),
  ('610000003', '2025-04-01', 1, 1000, NULL),
  ('610000003', '2026-04-01', 2, NULL, NULL),
  ('610000004', '2026-04-01', 2, 590, '2026-09-30'),
  ('610000005', '2026-04-01', 2, 980, NULL),
  ('620000006', '2026-04-01', 2, 10000, NULL),
  ('670000006', '2026-04-01', 2, 8733, NULL),
  ('670000006', '2026-06-01', 2, 7465, NULL);
INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'テスト薬局', '13', '9999999', '100-0000', '架空', '000'), (2, '別の薬局', '20', '9999998', '386-0000', '架空', '000');
INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations)
  VALUES (1, 1, 'test', 'テスト 薬剤師', 'x', 'x', 1);
INSERT INTO patients (id, pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by)
  VALUES (1, 1, '000001', '架空　太郎', 'カクウ　タロウ', '1960-01-01', 'M', 30, '2026-01-01T00:00:00Z', 1);
INSERT INTO pharmacy_facility VALUES (1, '2025-04-01', '1', 0, 1, 2, 3, 1, 0, 0), (1, '2026-06-01', '1', 1, 1, 0, 0, 0, 1, 1);
`;

// 調剤報酬の点数は、支払基金の調剤行為マスターの実ファイルを入れる（医薬品はこのファイルの架空の薬）
const FEE_MASTERS = MASTER_FILES.filter((f) => /\/m\d{8}\.csv$/.test(f));
let db;
beforeEach(async () => {
  db = openD1("db/schema.sql");
  db.exec(FIXTURE);
  for (const f of FEE_MASTERS) await loadMasterFile(db, f);
});

const user = { id: 1, pharmacy_id: 1 };
const price = async (code, date) => (await pricesAt(db, [code], date)).get(code);

test("改定日の前日は旧薬価、当日と翌日は新薬価", async () => {
  assert.equal((await price("610000001", "2026-03-31")).priceSen, 1500);
  assert.equal((await price("610000001", "2026-04-01")).priceSen, 1530);
  assert.equal((await price("610000001", "2026-04-02")).priceSen, 1530);
});

test("最初の版より前の日付は「未収載」", async () => {
  assert.equal((await price("610000001", "2025-03-31")).status, "before");
});

test("年度途中の収載品は、収載日より前だと使えない", async () => {
  assert.equal((await price("610000002", "2026-06-11")).status, "before");
  const d = await price("610000002", "2026-06-12");
  assert.equal(d.status, "ok");
  assert.equal(d.priceSen, 2000);
});

test("改定で廃止された品目は、改定日から使えない", async () => {
  assert.equal((await price("610000003", "2026-03-31")).status, "ok");
  assert.equal((await price("610000003", "2026-04-01")).status, "ended");
});

test("経過措置の品目は、使用期限の当日まで使え、翌日から使えない", async () => {
  assert.equal((await price("610000004", "2026-09-30")).status, "ok");
  assert.equal((await price("610000004", "2026-10-01")).status, "expired");
});

const rp = (usage, days, items) => ({ usage, rxDays: days, days, daysChange: null, items: items.map(([drugCode, dailyQty]) => ({ drugCode, dailyQty, rx: null })) });
const rxBody = (overrides = {}) => ({
  patientId: 1,
  prescribedOn: "2026-03-31",
  dispensedOn: "2026-03-31",
  handbook: "paper",
  inquiries: [],
  rps: [rp("1日1回朝食後", 14, [["610000001", "1"]])],
  ...overrides,
});

const count = async (table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

test("同じ処方でも、調剤日が改定の前か後かで点数が変わる", async () => {
  // 15.00円 → 1点 × 14日
  const before = await createPrescription(db, user, rxBody());
  assert.equal(before.drugPoints, 14);
  // 15.30円 → 2点 × 14日
  const after = await createPrescription(db, user, rxBody({ prescribedOn: "2026-04-01", dispensedOn: "2026-04-01" }));
  assert.equal(after.drugPoints, 28);

  const saved = await db.prepare("SELECT price_sen FROM prescription_items ORDER BY price_sen").all();
  assert.deepEqual(saved.results.map((r) => r.price_sen), [1500, 1530]);
});

test("保存すると処方・剤・明細・アクセスログが揃って入る", async () => {
  await createPrescription(db, user, rxBody({
    prescribedOn: "2026-04-01",
    dispensedOn: "2026-04-02",
    rps: [
      rp("1日1回朝食後", 14, [["610000001", "1"]]),
      rp("1日3回毎食後", 7, [["610000005", "1.5"]]),
    ],
  }));
  assert.equal(await count("prescriptions"), 1);
  assert.equal(await count("prescription_rps"), 2);
  assert.equal(await count("prescription_items"), 2);
  const log = await db.prepare("SELECT action, patient_id FROM access_logs").first();
  assert.deepEqual(log, { action: "prescription.create", patient_id: 1 });
  // 2点 × 14日 + 1点（9.80円 × 1.5g = 14.70円）× 7日
  assert.equal((await db.prepare("SELECT drug_points FROM prescriptions").first()).drug_points, 35);
});

test("明細の途中で失敗したら、処方も剤も1行も残らない", async () => {
  // batch に渡される文の、最後から2番目（＝明細の途中）に必ず失敗する文を差し込む
  const failing = {
    prepare: (sql) => db.prepare(sql),
    batch: (stmts) => {
      stmts.splice(stmts.length - 2, 0, db.prepare("INSERT INTO prescription_items (rp_id) VALUES (NULL)"));
      return db.batch(stmts);
    },
  };
  await assert.rejects(createPrescription(failing, user, rxBody({
    rps: [rp("1日1回朝食後", 14, [["610000001", "1"], ["610000003", "1"]])],
  })), /NOT NULL constraint failed/);
  assert.equal(await count("prescriptions"), 0);
  assert.equal(await count("prescription_rps"), 0);
  assert.equal(await count("prescription_items"), 0);
  assert.equal(await count("access_logs"), 0);
});

test("調剤日に使えない薬があれば保存しない", async () => {
  const body = rxBody({
    prescribedOn: "2026-04-01",
    dispensedOn: "2026-04-01",
    rps: [rp("1日1回", 7, [["610000003", "1"]])],
  });
  await assert.rejects(createPrescription(db, user, body), (e) => e instanceof HttpError && e.status === 422);
  assert.equal(await count("prescriptions"), 0);
});

test("入力の検証：処方箋の使用期間・未来日・重複", () => {
  const today = "2026-11-03";
  const errorsOf = (body) => {
    try {
      validatePrescription(body, today);
      return [];
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return e.details.map((d) => d.path);
    }
  };
  // 交付日を含めて4日目（交付日+3日）までは調剤できる
  assert.deepEqual(errorsOf(rxBody({ prescribedOn: "2026-10-01", dispensedOn: "2026-10-04" })), []);
  assert.deepEqual(errorsOf(rxBody({ prescribedOn: "2026-10-01", dispensedOn: "2026-10-05" })), ["dispensedOn"]);
  assert.deepEqual(errorsOf(rxBody({ prescribedOn: "2026-11-04", dispensedOn: "2026-11-04" })), ["dispensedOn"]);
  assert.deepEqual(errorsOf(rxBody({ prescribedOn: "2026-10-02", dispensedOn: "2026-10-01" })), ["dispensedOn"]);
  assert.deepEqual(errorsOf(rxBody({
    rps: [{ ...rp("", 0, [["610000001", "1"], ["610000001", "0"]]) }],
  })), ["rps.0.usage", "rps.0.days", "rps.0.rxDays", "rps.0.items.1.drugCode", "rps.0.items.1.dailyQty"]);
});

test("選定療養（患者希望）の（選）のコードは、対になるコードとの差が価格差になる", async () => {
  // 令和8年5月までは価格差の1/4、6月からは1/2 の金額が（選）のコードに入っている
  assert.equal((await price("670000006", "2026-05-31")).diffSen, 1267);
  assert.equal((await price("670000006", "2026-06-01")).diffSen, 2535);
  assert.equal((await price("620000006", "2026-06-01")).diffSen, null);
});

test("選定療養の薬を保存すると、保険の点数は（選）の価格で、特別の料金は別に残る", async () => {
  // 厚労省の計算例：74.65円 × 2錠 = 149.3円 → 15点 × 30日 = 450点、特別の料金 1,650円
  const saved = await createPrescription(db, user, rxBody({
    prescribedOn: "2026-10-01",
    dispensedOn: "2026-10-01",
    rps: [rp("1日2回朝夕食後", 30, [["670000006", "2"]])],
  }));
  assert.equal(saved.drugPoints, 450);
  assert.equal(saved.specialFeeYen, 1650);
  const rx = await db.prepare("SELECT drug_points, special_fee_yen, special_fee_method FROM prescriptions").first();
  assert.deepEqual(rx, { drug_points: 450, special_fee_yen: 1650, special_fee_method: "points" });
  assert.equal((await db.prepare("SELECT special_points FROM prescription_rps").first()).special_points, 150);
  assert.equal((await db.prepare("SELECT special_diff_sen FROM prescription_items").first()).special_diff_sen, 2535);
});
