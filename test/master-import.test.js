// 医薬品マスターの取り込み（public/assets/js/master-file.js → src/server/master-import.js）を、本番と同じ SQL で確かめる。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { parseMasterCsv, readMasterFile, FileFormatError } from "../public/assets/js/master-file.js";
import { startImport, addRows, previewImport, commitImport, discardImport, importHistory } from "../src/server/master-import.js";
import { loadMasterFile, MASTER_FILES } from "../src/dev/load-master.js";
import { pricesAt } from "../src/server/prices.js";
import { HttpError } from "../src/server/http.js";

const USER = 1;
let db;
beforeEach(() => {
  db = openD1("db/schema.sql");
  db.exec("INSERT INTO users (id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES (1, 'test', 'テスト', 'x', 'x', 1);");
});

// 医薬品マスターの1行（42項目）。項番で値を指定し、残りは全件ファイルと同じ既定値
function row(values) {
  const r = Array(42).fill("0");
  Object.assign(r, { 0: "0", 1: "Y", 4: "試験錠", 9: "錠", 10: "1", 11: "10.00", 27: "1", 28: "", 29: "20260401", 30: "99999999", 31: "1111111F1011", 34: "試験錠", 36: "", 37: "" });
  for (const [no, v] of Object.entries(values)) r[no - 1] = v;
  return r.join(",");
}
// 改定分の変更行：指定した項番だけ値が入り、残りは空
function diffRow(values) {
  const r = Array(42).fill("");
  r[1] = "Y";
  for (const [no, v] of Object.entries(values)) r[no - 1] = v;
  return r.join(",");
}
const csv = (...lines) => lines.join("\r\n") + "\r\n";

// 画面と同じ手順で取り込む。commit: false なら確認まで
async function upload(text, publishedOn, { commit = true } = {}) {
  const file = parseMasterCsv(text);
  const id = await startImport(db, USER, { master: file.master, kind: file.kind, publishedOn, fileName: `y_${publishedOn}.csv`, expectedRows: file.rows.length });
  await addRows(db, USER, id, JSON.stringify(file.rows));
  const preview = await previewImport(db, USER, id, "2026-11-04");
  if (commit) await commitImport(db, USER, id);
  return { id, preview, file };
}
const at = async (code, date) => (await pricesAt(db, [code], date)).get(code);
const rows = async (code) => (await db.prepare("SELECT valid_from, price_sen, transitional_until FROM drug_prices WHERE drug_code = ?1 ORDER BY valid_from").bind(code).all()).results;

test("全件：変更年月日から、その金額。前日まではまだ収載されていない", async () => {
  await upload(csv(row({ 3: "610000001", 12: "15.30", 30: "20260401" })), "2026-03-19");
  assert.equal((await at("610000001", "2026-03-31")).status, "before");
  assert.equal((await at("610000001", "2026-04-01")).priceSen, 1530);
});

test("次のマスターで金額が変われば、その変更年月日から新しい金額。前日までは前の金額", async () => {
  await upload(csv(row({ 3: "610000001", 12: "13.70", 30: "20250401" })), "2025-03-18");
  await upload(csv(row({ 3: "610000001", 12: "10.80", 30: "20260401" })), "2026-03-19");
  assert.equal((await at("610000001", "2026-03-31")).priceSen, 1370);
  assert.equal((await at("610000001", "2026-04-01")).priceSen, 1080);
});

test("同じマスターをもう一度入れても、薬価の履歴は増えない", async () => {
  const text = csv(row({ 3: "610000001", 12: "10.80" }), row({ 3: "610000002", 12: "20.00" }));
  await upload(text, "2026-03-19");
  const again = await upload(text, "2026-03-19");
  assert.equal(again.preview.counts.priceWrites, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM drug_prices").first()).n, 2);
});

test("先の日付の変更（例：12月1日から）は、その日から。確認では「これから効く変更」として数える", async () => {
  await upload(csv(row({ 3: "610000001", 12: "100.00" })), "2026-03-19");
  const { preview } = await upload(csv(diffRow({ 1: "5", 3: "610000001", 12: "120.00", 30: "20261201" })), "2026-10-13");
  assert.deepEqual(preview.scheduled, [{ date: "2026-12-01", count: 1 }]);
  assert.equal((await at("610000001", "2026-11-30")).priceSen, 10000);
  assert.equal((await at("610000001", "2026-12-01")).priceSen, 12000);
});

test("改定分の変更行は、入っている項目だけ変える（経過措置だけ・一般名だけ）", async () => {
  await upload(csv(row({ 3: "610000001", 12: "10.00", 38: "【般】しけん錠" })), "2026-03-19");
  await upload(csv(diffRow({ 1: "5", 3: "610000001", 30: "20260701", 34: "20260930" })), "2026-06-30");
  assert.deepEqual(await rows("610000001"), [
    { valid_from: "2026-04-01", price_sen: 1000, transitional_until: null },
    { valid_from: "2026-07-01", price_sen: 1000, transitional_until: "2026-09-30" },
  ]);
  assert.equal((await at("610000001", "2026-10-01")).status, "expired");
  await upload(csv(diffRow({ 1: "5", 3: "610000001", 30: "20260801", 38: "【般】べつの錠" })), "2026-07-14");
  const d = await db.prepare("SELECT general_name, name FROM drugs").first();
  assert.deepEqual(d, { general_name: "【般】べつの錠", name: "試験錠" });
  assert.equal((await rows("610000001")).length, 2); // 金額も経過措置も変わらないので、履歴は増えない
});

test("廃止（変更区分 9）：廃止年月日（使える最終日）の翌日から使えない", async () => {
  await upload(csv(row({ 3: "610000001" })), "2026-03-19");
  await upload(csv(diffRow({ 1: "9", 3: "610000001", 30: "20261001", 31: "20260930" })), "2026-09-11");
  assert.equal((await at("610000001", "2026-09-30")).status, "ok");
  assert.equal((await at("610000001", "2026-10-01")).status, "ended");
});

test("全件に無くなったコード：経過措置の期限があれば翌日から、無ければ公表日から使えない", async () => {
  await upload(csv(
    row({ 3: "610000001" }),
    row({ 3: "610000002", 34: "20260930" }),
    row({ 3: "610000003" }),
  ), "2026-03-19");
  const { preview } = await upload(csv(row({ 3: "610000003" })), "2026-10-13");
  assert.equal(preview.counts.disappeared, 2);
  assert.equal((await at("610000001", "2026-10-12")).status, "ok");
  assert.equal((await at("610000001", "2026-10-13")).status, "ended");
  assert.equal((await at("610000002", "2026-10-01")).status, "ended");
});

test("取り込み済みより古い公表日の全件では、無くなったコードを廃止にせず、名称も上書きしない", async () => {
  await upload(csv(row({ 3: "610000001", 35: "新しい名前" }), row({ 3: "610000002" })), "2026-10-13");
  const { preview } = await upload(csv(row({ 3: "610000001", 35: "古い名前" })), "2026-03-19");
  assert.equal(preview.olderThan, "2026-10-13");
  assert.equal(preview.counts.disappeared, 0);
  assert.equal((await at("610000002", "2026-11-01")).status, "ok");
  assert.equal((await db.prepare("SELECT name FROM drugs WHERE code = '610000001'").first()).name, "新しい名前");
});

test("改定分の変更行のうち、取り込み済みの薬に無いコード（注射薬など）は数えるだけで入れない", async () => {
  await upload(csv(row({ 3: "610000001" })), "2026-03-19");
  const { preview } = await upload(csv(diffRow({ 1: "5", 3: "620000099", 12: "500.00", 30: "20260601" })), "2026-05-12");
  assert.equal(preview.counts.ignored, 1);
  assert.equal(preview.counts.priceWrites, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM drugs").first()).n, 1);
});

test("選定療養（患者希望）のコード：対になるコードとの差が価格差になる", async () => {
  await upload(csv(
    row({ 3: "620000063", 12: "27.20", 42: "1" }),
    row({ 3: "670000063", 12: "21.05", 41: "620000063", 42: "2", 35: "試験錠（選）" }),
  ), "2026-10-13");
  const d = await at("670000063", "2026-11-01");
  assert.equal(d.sentei, 2);
  assert.equal(d.diffSen, 615);
});

test("一部保険外療養（OTC 類似薬）のコードと、内用薬以外の行は取り込まない", () => {
  const file = parseMasterCsv(csv(
    row({ 3: "610000001" }),
    row({ 3: "650000001", 41: "610000001", 42: "0" }),
    row({ 3: "620000002", 28: "4" }),
  ));
  assert.equal(file.rows.length, 1);
  assert.deepEqual(file.skipped, { otherForms: 1, partialOtc: 1, noYjCode: 0 });
});

test("確認の前に行が揃っていなければ止める。中止すれば作業は消え、薬価マスタは変わらない", async () => {
  await upload(csv(row({ 3: "610000001", 12: "10.00" })), "2026-03-19");
  const file = parseMasterCsv(csv(row({ 3: "610000001", 12: "99.00", 30: "20261101" }), row({ 3: "610000002" })));
  const id = await startImport(db, USER, { master: "drug", kind: file.kind, publishedOn: "2026-10-13", fileName: "y_ALL20261013.zip", expectedRows: 2 });
  await addRows(db, USER, id, JSON.stringify(file.rows.slice(0, 1)));
  await assert.rejects(previewImport(db, USER, id), (e) => e instanceof HttpError && e.status === 409);
  await assert.rejects(commitImport(db, USER, id), (e) => e instanceof HttpError && e.status === 409);
  await discardImport(db, USER, id);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM staging_rows").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM pending_imports").first()).n, 0);
  assert.equal((await at("610000001", "2026-11-01")).priceSen, 1000);
});

test("反映は1つのトランザクション。途中で失敗したら薬も薬価も取り込みの記録も何も残らない", async () => {
  await upload(csv(row({ 3: "610000001", 12: "10.00" })), "2026-03-19");
  db.exec("CREATE TRIGGER fail BEFORE INSERT ON access_logs BEGIN SELECT RAISE(ABORT, 'test'); END;");
  await assert.rejects(upload(csv(row({ 3: "610000001", 12: "20.00", 30: "20261101" }), row({ 3: "610000002" })), "2026-10-13"));
  assert.equal((await at("610000001", "2026-11-01")).priceSen, 1000);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM drugs").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM master_imports").first()).n, 1);
});

test("他人の取り込み作業には触れない", async () => {
  db.exec("INSERT INTO users (id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES (2, 'b', 'B', 'x', 'x', 1);");
  const file = parseMasterCsv(csv(row({ 3: "610000001" })));
  const id = await startImport(db, USER, { master: "drug", kind: file.kind, publishedOn: "2026-03-19", fileName: "y.csv", expectedRows: 1 });
  await assert.rejects(addRows(db, 2, id, JSON.stringify(file.rows)), (e) => e instanceof HttpError && e.status === 404);
  await assert.rejects(commitImport(db, 2, id), (e) => e instanceof HttpError && e.status === 404);
});

test("医薬品マスターでない・壊れた行は、行番号付きで止める", () => {
  const bad = (text, pattern) => assert.throws(() => parseMasterCsv(text), (e) => e instanceof FileFormatError && pattern.test(e.message));
  bad(csv(row({ 3: "610000001" }).split(",").slice(0, 41).join(",")), /^1行目：項目が41個/);
  bad(csv(row({ 3: "610000001", 2: "S" })), /マスター種別/);
  bad(csv(row({ 3: "610000001" }), row({ 3: "61000002" })), /^2行目：医薬品コード/);
  bad(csv(row({ 3: "610000001", 12: "9.5" })), /金額/);
  bad(csv(row({ 3: "610000001", 30: "20260231" })), /変更年月日/);
  bad(csv(row({ 3: "610000001" }), row({ 3: "610000001" })), /2回/);
});

test("Shift_JIS でないファイル・ZIP でないファイルは読まない", async () => {
  await assert.rejects(readMasterFile("y_20261013.csv", new TextEncoder().encode(csv(row({ 3: "610000001" })))), FileFormatError);
  await assert.rejects(readMasterFile("y_ALL20261013.zip", new TextEncoder().encode("not a zip")), FileFormatError);
  await assert.rejects(readMasterFile("yakka.xlsx", new Uint8Array(10)), FileFormatError);
  const zip = new Uint8Array(readFileSync("data/raw/master/y_ALL20261013.zip"));
  zip.fill(0, 2000, 3000); // 中身を壊す
  await assert.rejects(readMasterFile("y_ALL20261013.zip", zip), FileFormatError);
});

// 支払基金の実ファイルを公表順に入れる（npm run db:import と同じ）
test("実データ：改定分を順に当てた結果が、最新の全件ファイルと一致する。改定・年度途中の変更・廃止・選定療養", async () => {
  const results = [];
  for (const path of MASTER_FILES) results.push(await loadMasterFile(db, path, { userId: USER, today: "2026-11-04" }));
  const last = results.at(-1).preview.counts;
  assert.equal(last.priceWrites, 0);
  assert.equal(last.disappeared, 0);
  assert.equal(last.newCodes, 0);

  // ノルバスク錠５ｍｇ：令和8年4月の改定で 13.70円 → 10.80円
  assert.equal((await at("612170710", "2026-03-31")).priceSen, 1370);
  assert.equal((await at("612170710", "2026-04-01")).priceSen, 1080);
  // パキロビッドパック３００：10/13 公表の改定分で、11月1日から新しい金額
  assert.equal((await at("622937701", "2026-11-01")).priceSen, 1200120);
  assert.notEqual((await at("622937701", "2026-10-31")).priceSen, 1200120);
  // パンクレアチン「三恵」：6/30 で経過措置、9/11 で廃止（9月30日まで）
  assert.equal((await at("610408658", "2026-09-30")).status, "ok");
  assert.equal((await at("610408658", "2026-10-01")).status, "ended");
  // ロキソニン錠６０ｍｇ（選）：価格差は令和8年5月まで 1/4、6月から 1/2
  assert.equal((await at("670098801", "2026-05-31")).diffSen, 1080 - 1072);
  assert.equal((await at("670098801", "2026-06-01")).diffSen, 1080 - 1065);
  // 令和8年3月31日で廃止になったコードは、4月1日から使えない
  const ended = await db.prepare("SELECT COUNT(*) AS n FROM drug_prices WHERE valid_from = '2026-04-01' AND price_sen IS NULL").first();
  assert.equal(ended.n, 618);
  const history = await importHistory(db, "2026-11-04");
  assert.equal(history.imports.length, MASTER_FILES.length - 2); // 内用薬の行が無い改定分（6/19・10/1）は取り込まない
});
