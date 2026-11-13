// 「この日付時点の薬価」の SQL と、処方の保存（トランザクション）を、本番と同じコードで確かめる。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { pricesAt } from "../src/server/prices.js";
import { createPrescription, validatePrescription, revisePrescription, prescriptionsOf } from "../src/server/prescriptions.js";
import { HttpError } from "../src/server/http.js";
import { deleteReception } from "../src/server/reception.js";
import { getPatient, updateHandbookKind } from "../src/server/patients.js";
import { compareRx } from "../src/server/rx-compare.js";
import { previewPrescription } from "../src/server/rx-preview.js";
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

test("保存すると、渡した量（1日量 × 調剤した日数）を自分の薬局の在庫から引く。在庫を記録していない薬はそのまま", async () => {
  db.exec("INSERT INTO drug_stock VALUES (1, '610000001', 100000, '2026-11-13T00:00:00Z'), (2, '610000001', 100000, '2026-11-13T00:00:00Z')");
  await createPrescription(db, user, {
    patientId: 1, prescribedOn: "2026-06-15", dispensedOn: "2026-06-15", handbook: "paper", inquiries: [],
    rps: [{ usage: "1日2回", rxDays: 14, days: 7, daysChange: "instruction", items: [{ drugCode: "610000001", dailyQty: "2" }, { drugCode: "610000005", dailyQty: "1.5" }] }],
  });
  const stock = async (ph, code) => (await db.prepare("SELECT qty_milli FROM drug_stock WHERE pharmacy_id = ?1 AND drug_code = ?2").bind(ph, code).first())?.qty_milli;
  assert.equal(await stock(1, "610000001"), 86000); // 100 − 2錠 × 7日（処方箋は14日分でも、渡したのは7日分）
  assert.equal(await stock(2, "610000001"), 100000); // ほかの薬局の在庫は変わらない
  assert.equal(await stock(1, "610000005"), undefined); // 在庫を記録していない薬は行を作らない
});

test("改定をまたいで比べる：保存した処方を別の日付の薬価で計算し直す。日付を省くと、次に薬価が変わる日か、直前に変わった日の前日", async () => {
  const saved = await createPrescription(db, user, rxBody({
    prescribedOn: "2026-06-01", dispensedOn: "2026-06-01",
    rps: [rp("1日1回朝食後", 14, [["610000001", "1"], ["670000006", "2"]])],
  }));
  const c = await compareRx(db, saved.id, "2026-03-31");
  assert.equal(c.date, "2026-03-31");
  assert.equal(c.drugPoints, saved.drugPoints);
  assert.equal(c.compareDrugPoints, null); // （選）のコードは 3/31 にはまだ無い
  assert.equal(c.rps[0].items[1].compareStatus, "before");
  const auto = await compareRx(db, saved.id, null);
  assert.ok(auto.date < "2026-06-01" || auto.date > "2026-06-01");
  await assert.rejects(compareRx(db, saved.id, "2026-13-01"), HttpError);
});

test("疑義照会は、どの剤・どの薬についてかを持つ。送った処方に無い剤・薬は指せない", async () => {
  const body = (inquiry) => ({
    patientId: 1, prescribedOn: "2026-06-15", dispensedOn: "2026-06-15", handbook: "paper",
    rps: [{ usage: "1日2回", rxDays: 14, days: 7, daysChange: "inquiry", items: [{ drugCode: "610000001", dailyQty: "2" }] },
      { usage: "1日1回", rxDays: 14, days: 14, daysChange: null, items: [{ drugCode: "610000005", dailyQty: "1" }] }],
    inquiries: [{ kind: "leftover", content: "7日分残っている", answer: "7日分で可", changed: true, ...inquiry }],
  });
  const paths = (inquiry) => {
    try {
      validatePrescription(body(inquiry));
      return [];
    } catch (e) {
      return e.details.map((d) => d.path);
    }
  };
  assert.deepEqual(paths({ rpNo: 1, drugCode: "610000001" }), []);
  assert.deepEqual(paths({ rpNo: 3 }), ["rps.0.daysChange", "inquiries.0.target"]); // 無い剤を指す照会は、Rp1 を減らした根拠にもならない
  assert.deepEqual(paths({ rpNo: 1, drugCode: "610000005" }), ["inquiries.0.target"]);
  assert.deepEqual(paths({ rpNo: null, drugCode: "610000001" }), ["inquiries.0.target"]);
  assert.deepEqual(paths({ rpNo: 2 }), ["rps.0.daysChange"]); // Rp1 を減らした根拠の照会が、Rp2 のものになっている
  const saved = await createPrescription(db, user, body({ rpNo: 1, drugCode: "610000001" }));
  assert.deepEqual({ ...(await db.prepare("SELECT rp_no, drug_code FROM inquiries WHERE prescription_id = ?1").bind(saved.id).first()) }, { rp_no: 1, drug_code: "610000001" });
});

test("お薬手帳の形態は患者に残る：出された手帳に合わせ、「提示なし」では前の形態を消さない。薬歴から選び直せる", async () => {
  const save = (handbook, on) => createPrescription(db, user, {
    patientId: 1, prescribedOn: on, dispensedOn: on, handbook, inquiries: [],
    rps: [{ usage: "1日2回", rxDays: 7, days: 7, daysChange: null, items: [{ drugCode: "610000001", dailyQty: "2" }] }],
  });
  assert.equal((await getPatient(db, 1)).handbookKind, null); // まだ聞いていない
  await save("electronic", "2026-06-15");
  assert.equal((await getPatient(db, 1)).handbookKind, "electronic");
  await save("none", "2026-06-29"); // 今日は忘れただけ
  assert.equal((await getPatient(db, 1)).handbookKind, "electronic");
  await save("paper", "2026-07-13");
  assert.equal((await getPatient(db, 1)).handbookKind, "paper");
  assert.equal((await updateHandbookKind(db, user, 1, { handbookKind: "none" })).handbookKind, "none");
  await assert.rejects(updateHandbookKind(db, user, 1, { handbookKind: "app" }), HttpError);
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

// 処方入力の途中の計算（画面に配らずサーバーで出す）と、保存時の計算が同じになること
test("途中の計算と保存時の計算が一致する（選定療養の特別の料金も出る）", async () => {
  const body = rxBody({
    prescribedOn: "2026-06-01", dispensedOn: "2026-06-01",
    rps: [rp("1日1回朝食後", 14, [["610000001", "1"], ["670000006", "2"]])],
  });
  const preview = await previewPrescription(db, {
    patientId: 1, dispensedOn: body.dispensedOn, handbook: body.handbook, pending: false, inquiries: [], kohi: [],
    rps: [{ r: 0, usage: "1日1回朝食後", complete: true, days: 14, rxDays: 14, daysChange: null,
      items: [{ i: 0, drugCode: "610000001", dailyQtyMilli: 1000 }, { i: 1, drugCode: "670000006", dailyQtyMilli: 2000 }] }],
  });
  const saved = await createPrescription(db, user, body);
  assert.equal(preview.drugPoints, saved.drugPoints);
  assert.equal(preview.bill.total, saved.totalPoints);
  assert.equal(preview.bill.copayYen, saved.copayYen);
  assert.equal(preview.bill.specialYen, saved.specialFeeYen);
  assert.equal(preview.bill.chargeYen, saved.patientPayYen + saved.specialFeeYen);
  assert.deepEqual(preview.items.map((x) => x.costYen), ["15.30", "149.30"]);
  assert.equal(preview.pediatric, null);       // 66歳
});

test("処方を直す：中身を差し替え、直す前を残す。在庫は差の分。会計の後なら受け取った額を残し、監査からやり直す", async () => {
  db.exec("INSERT INTO drug_stock VALUES (1, '610000001', 100000, '2026-11-13T00:00:00Z'), (1, '610000005', 100000, '2026-11-13T00:00:00Z')");
  db.exec("INSERT INTO receptions (id, patient_id, received_at, created_by) VALUES (1, 1, '2026-06-15T00:00:00Z', 1)");
  const body = rxBody({ prescribedOn: "2026-06-15", dispensedOn: "2026-06-15", receptionId: 1 });
  const saved = await createPrescription(db, user, body);
  for (const s of ["audited", "handed", "paid"]) db.exec(`INSERT INTO reception_steps VALUES (1, '${s}', '2026-06-15T01:00:00Z', 1)`);
  const stock = async (code) => (await db.prepare("SELECT qty_milli FROM drug_stock WHERE pharmacy_id = 1 AND drug_code = ?1").bind(code).first()).qty_milli;
  assert.equal(await stock("610000001"), 86000);

  // 同じ内容のままでは直さない
  await assert.rejects(revisePrescription(db, user, saved.id, body), (e) => e.status === 422);
  // 別の患者の処方として送っても直さない
  await assert.rejects(revisePrescription(db, user, saved.id, { ...body, patientId: 2 }), (e) => e.status === 422);

  const r = await revisePrescription(db, user, saved.id, { ...body, rps: [rp("1日1回朝食後", 14, [["610000001", "2"]]), rp("1日3回毎食後", 7, [["610000005", "1.5"]])] });
  assert.equal(r.contentChanged, true);
  assert.deepEqual(r.reopened, ["audited", "handed", "paid"]);       // 薬が変わったので監査から
  assert.ok(r.receivedYen > 0 && r.payYen > r.receivedYen);          // 受け取っていた額と、直した後の額
  assert.equal(await stock("610000001"), 72000);                     // 戻して（+14）引き直す（−28）
  assert.equal(await stock("610000005"), 89500);
  assert.equal(await count("prescriptions"), 1);                     // ID はそのまま
  assert.equal(await count("prescription_items"), 2);
  assert.deepEqual((await db.prepare("SELECT step FROM reception_steps").all()).results.map((s) => s.step), ["entered"]);
  const v = await db.prepare("SELECT before_json, summary, received_yen FROM prescription_revisions").first();
  assert.equal(JSON.parse(v.before_json).prescription.rps[0].items[0].dailyQtyMilli, 1000); // 直す前の中身が残る
  assert.match(v.summary, /1日量 1 → 2[\s\S]*追加 1g単位の散/);
  const [rx] = await prescriptionsOf(db, 1);
  assert.equal(rx.revisions.length, 1);
  assert.equal(rx.revisions[0].receivedYen, r.receivedYen);

  // 会計を外した後、まだ受け取っていないうちにもう一度直しても、受け取った額は最初のまま
  const r2 = await revisePrescription(db, user, saved.id, { ...body, handbook: "electronic", rps: [rp("1日1回朝食後", 14, [["610000001", "2"]])] });
  assert.equal(r2.receivedYen, r.receivedYen);
  assert.match(r2.summary.join("／"), /お薬手帳 紙 → 電子版[\s\S]*削除 1g単位の散/);
});

test("受付の記録を消す：処方・監査・指導記録・訂正の記録まで消し、在庫を戻す。消したことは閲覧記録に残る", async () => {
  db.exec("INSERT INTO drug_stock VALUES (1, '610000001', 100000, '2026-11-13T00:00:00Z')");
  db.exec("INSERT INTO receptions (id, patient_id, received_at, created_by) VALUES (1, 1, '2026-06-15T00:00:00Z', 1)");
  const body = rxBody({ prescribedOn: "2026-06-15", dispensedOn: "2026-06-15", receptionId: 1 });
  const saved = await createPrescription(db, user, body);
  await revisePrescription(db, user, saved.id, { ...body, rps: [rp("1日1回朝食後", 14, [["610000001", "2"]])] });
  db.exec(`INSERT INTO inspections VALUES ('i1', '${saved.id}', '2026-06-15T01:00:00Z', 1)`);
  db.exec(`INSERT INTO inspection_scans (inspection_id, line_no, gtin, drug_code, expiry, lot, result) VALUES ('i1', 1, '14987114335002', '610000001', NULL, NULL, 'match')`);
  db.exec(`INSERT INTO guidance_records (prescription_id, patient_id, subjective, objective, assessment, plan, leftover, drafted, created_at, created_by)
           VALUES ('${saved.id}', 1, '変わりない', '', '', '', 'none', 0, '2026-06-15T01:00:00Z', 1)`);
  db.exec("INSERT INTO reception_steps VALUES (1, 'audited', '2026-06-15T01:00:00Z', 1)");
  assert.equal((await db.prepare("SELECT qty_milli FROM drug_stock").first()).qty_milli, 72000);

  await deleteReception(db, user, 1);
  for (const t of ["receptions", "reception_steps", "prescriptions", "prescription_rps", "prescription_items", "prescription_fees",
    "prescription_revisions", "inspections", "inspection_scans", "guidance_records"]) assert.equal(await count(t), 0, t);
  assert.equal((await db.prepare("SELECT qty_milli FROM drug_stock").first()).qty_milli, 100000); // 渡した分を戻す
  assert.match((await db.prepare("SELECT detail FROM access_logs WHERE action = 'reception.delete'").first()).detail, /受付を削除（調剤日 2026-06-15 の処方/);
  await assert.rejects(deleteReception(db, user, 1), (e) => e.status === 404);
});
