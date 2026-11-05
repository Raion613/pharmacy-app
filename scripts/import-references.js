// 医薬品マスター以外の参照データを取り込み、db/generated/references.sql に書き出す。npm run db:references から呼ぶ。
//   1. 薬の箱のバーコード → 医薬品コード（調剤監査）
//      MEDIS「医薬品HOTコードマスター」販売包装単位コード付き版（data/raw/hot/h20260930_h.zip、Shift_JIS の CSV）
//      https://www2.medis.or.jp/hcode/ 。内用薬（区分「内」）の行のうち、販売包装単位コード（GTIN-14）がある行を使う
//   2. 後発医薬品のある先発医薬品（後発医薬品の使用割合の分母）
//      厚生労働省「薬価基準収載品目リスト」内用薬（data/raw/yakka_20261101_naiyo.xlsx、令和8年11月1日適用）の
//      「同一剤形・規格の後発医薬品がある先発医薬品」欄に「○」がある品目
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { openZip } from "../public/assets/js/zip.js";
import { gtinCheckDigitOk } from "../public/assets/js/gs1.js";

const HOT_ZIP = "data/raw/hot/h20260930_h.zip";
const HOT_FILE = "h20260930_h/MEDIS20260930_h.txt";
const YAKKA_XLSX = "data/raw/yakka_20261101_naiyo.xlsx";
const YAKKA_DATE = "2026-11-01";
const OUT = "db/generated/references.sql";

// ---------- HOT コードマスター ----------
// 列：0 HOTコード … 8 レセプト電算処理システムコード（1） … 14 包装形態 15 包装単位数 16 包装単位単位 17 包装総量数 18 包装総量単位 19 区分 … 24 販売包装単位コード
const hotZip = openZip(new Uint8Array(readFileSync(HOT_ZIP)));
const hotText = new TextDecoder("shift_jis", { fatal: true }).decode(await hotZip.read(HOT_FILE));
const [header, ...hotRows] = hotText.split(/\r?\n/).filter(Boolean).map((l) => l.split(","));
if (header[8] !== "レセプト電算処理システムコード（１）" || header[19] !== "区分" || header[24] !== "販売包装単位コード") {
  throw new Error(`HOTコードマスターの列が想定と違います: ${header.join(",")}`);
}
const packages = new Map();
let skipped = 0;
for (const r of hotRows) {
  if (r[19] !== "内" || !/^\d{14}$/.test(r[24]) || !/^6\d{8}$/.test(r[8])) continue;
  if (!gtinCheckDigitOk(r[24])) throw new Error(`チェックデジットの合わない販売包装単位コード: ${r[24]}（${r[0]}）`);
  if (packages.has(r[24])) {
    skipped++; // 同じ GTIN が複数の HOT コードに付いている行は、最初の行を使う
    continue;
  }
  const [form, unitCount, unitName, total, totalUnit] = [r[14], Number(r[15]), r[16], Number(r[17]), r[18]];
  const per = unitCount > 0 && total !== unitCount ? `（${unitCount}${unitName}×${total / unitCount}）` : "";
  packages.set(r[24], { drugCode: r[8], hot: r[0], text: `${form ? `${form} ` : ""}${total}${totalUnit}${per}` });
}

// ---------- 薬価基準収載品目リスト（xlsx） ----------
// xlsx は ZIP の中の XML。文字列は sharedStrings.xml に1か所にまとめてあり、セルはその番号を持つ
const xlsx = openZip(new Uint8Array(readFileSync(YAKKA_XLSX)));
const utf8 = new TextDecoder();
const shared = [...utf8.decode(await xlsx.read("xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)]
  .map((m) => m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&"));
const sheet = utf8.decode(await xlsx.read("xl/worksheets/sheet1.xml"));
const cellsOf = (row) => Object.fromEntries([...row.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, col, attrs, body]) => {
  const v = body?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
  return [col, attrs.includes('t="s"') && v !== "" ? shared[Number(v)] : v];
}));
const [head, ...rows] = [...sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((m) => cellsOf(m[1]));
if (head.B !== "薬価基準収載医薬品コード" || head.L !== "同一剤形・規格の後発医薬品がある先発医薬品") {
  throw new Error(`薬価基準収載品目リストの列が想定と違います: B=${head.B} L=${head.L}`);
}
const flagged = rows.filter((r) => r.L === "○").map((r) => r.B);

// ---------- 書き出し ----------
const sql = (v) => `'${String(v).replace(/'/g, "''")}'`;
const lines = ["DELETE FROM drug_packages;", "DELETE FROM generic_flags;"];
const pk = [...packages.entries()];
for (let i = 0; i < pk.length; i += 300) {
  lines.push(`INSERT INTO drug_packages (gtin, drug_code, hot_code, package) VALUES\n${pk.slice(i, i + 300)
    .map(([g, p]) => `(${sql(g)},${sql(p.drugCode)},${sql(p.hot)},${sql(p.text)})`).join(",\n")};`);
}
for (let i = 0; i < flagged.length; i += 300) {
  lines.push(`INSERT INTO generic_flags (yj_code, list_date) VALUES\n${flagged.slice(i, i + 300).map((y) => `(${sql(y)},${sql(YAKKA_DATE)})`).join(",\n")};`);
}
mkdirSync("db/generated", { recursive: true });
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log(`バーコード ${packages.size}件（同じ GTIN の重複 ${skipped}件は除外）/ 後発医薬品のある先発医薬品 ${flagged.length}品目 → ${OUT}`);
