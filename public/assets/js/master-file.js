// 支払基金の基本マスターのファイルを読み、取り込む行に直す。
// ブラウザ（取り込み画面）と Node（初期データの作成・テスト）で同じものを使う。
//
// 扱うマスター（レセプト電算処理システム マスターファイル仕様説明書 令和8年度版）。CSV は Shift_JIS。
//   医薬品マスター（マスター種別 Y、1行42項目）。内用薬だけを取り込む
//     全件ファイル  y_ALL20261013.zip（中に同名の .csv）… その時点の全コード。変更区分 0 の行を含む
//     改定分ファイル y_20261013.csv … 変わったコードだけ。変更区分 3（新規）以外の行は、変わった項目しか入っていない
//   調剤行為マスター（マスター種別 M、1行65項目）。全件ファイル m20260911.csv だけが公表される
import { searchKey } from "./text.js";
import { openZip, FileFormatError } from "./zip.js";

export { FileFormatError };

// 項番（1始まり）
const F = {
  changeKind: 1, masterType: 2, code: 3, unitName: 10, amountKind: 11, price: 12, narcotic: 14, generic: 17,
  dosageForm: 28, changeDate: 30, endDate: 31, yjCode: 32, transitional: 34, name: 35,
  generalName: 38, related: 41, sentei: 42,
};
const LABEL = {
  yjCode: "薬価基準収載医薬品コード", name: "基本漢字名称", unitName: "単位", generic: "後発品", sentei: "選定療養区分",
  related: "長期収載品関連", price: "新又は現金額", changeDate: "変更年月日", narcotic: "麻薬・毒薬・覚醒剤原料・向精神薬",
};
const FIELD_COUNT = 42;
const NAIYO = "1"; // 剤形：内用薬

// 送る行の並び。サーバー（src/server/master-import.js）の INSERT と揃える
export const ROW_COLUMNS = [
  "line_no", "change_kind", "code", "yj_code", "name", "unit", "generic", "general_name", "general_key", "name_key",
  "sentei", "pair_code", "price_sen", "change_date", "end_date", "transitional_until", "narcotic",
];
export const FEE_ROW_COLUMNS = ["line_no", "change_kind", "code", "name", "point_kind", "points_x100", "change_date", "end_date"];

// 調剤行為マスターの項番
const M = { changeKind: 1, masterType: 2, code: 3, name: 5, pointKind: 10, points: 12, changeDate: 60, endDate: 61 };
const FEE_FIELD_COUNT = 65;

// ファイル（.zip か .csv）を読む。{ master, kind, publishedOn, rows, skipped } を返す。
//   master      … "drug"（医薬品マスター）か "fee"（調剤行為マスター）
//   publishedOn … ファイル名の日付（y_ALL20261013 → 2026-10-13）。読めなければ null
//   skipped     … 取り込まない行の数 { otherForms：内用薬以外, partialOtc：一部保険外療養の対象（未対応）,
//                   noYjCode：薬価基準収載医薬品コードの無いコード（「薬評（内用薬）」のような請求用のコード） }
export async function readMasterFile(name, bytes) {
  let csvBytes = bytes;
  if (/\.zip$/i.test(name)) {
    const zip = openZip(bytes);
    const csvs = zip.names.filter((n) => /\.csv$/i.test(n));
    if (csvs.length !== 1) throw new FileFormatError("ZIP の中に CSV が1つだけ入っている形ではありません");
    csvBytes = await zip.read(csvs[0]);
  } else if (!/\.csv$/i.test(name)) {
    throw new FileFormatError("基本マスターの .zip か .csv を選んでください");
  }
  let text;
  try {
    text = new TextDecoder("shift_jis", { fatal: true }).decode(csvBytes);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    throw new FileFormatError("Shift_JIS の CSV として読めません");
  }
  return { ...parseMasterCsv(text), publishedOn: dateInFileName(name) };
}

export function parseMasterCsv(text) {
  const records = parseCsv(text);
  if (records.length === 0) throw new FileFormatError("行が1つもありません");
  if (records[0][M.masterType - 1] === "M") return parseFeeRecords(records);
  return parseDrugRecords(records);
}

// 調剤行為マスター。全件ファイルだけなので、どの行も全項目が入っている
function parseFeeRecords(records) {
  const rows = [];
  const seen = new Set();
  records.forEach((r, i) => {
    const line = i + 1;
    const fail = (message) => { throw new FileFormatError(`${line}行目：${message}`); };
    if (r.length !== FEE_FIELD_COUNT) fail(`項目が${r.length}個あります（調剤行為マスターは${FEE_FIELD_COUNT}個）`);
    const get = (key) => r[M[key] - 1];
    if (get("masterType") !== "M") fail("調剤行為マスターの行ではありません（マスター種別が M ではない）");
    const changeKind = get("changeKind");
    if (!["0", "3", "5", "9"].includes(changeKind)) fail(`変更区分「${changeKind}」を読めません`);
    const code = get("code");
    if (!/^4\d{8}$/.test(code)) fail(`調剤行為コード「${code}」が9桁ではありません`);
    if (seen.has(code)) fail(`調剤行為コード ${code} が2回出てきます`);
    seen.add(code);
    const pointKind = get("pointKind");
    if (!["3", "5", "6", "7", "8", "9"].includes(pointKind)) fail(`点数識別「${pointKind}」を読めません`);
    if (!/^\d{1,9}$/.test(get("points"))) fail(`点数「${get("points")}」を読めません`);
    if (get("name") === "") fail("漢字名称が空です");
    rows.push([
      line,
      changeKind,
      code,
      get("name"),
      pointKind,
      Number(get("points")), // 下2桁が小数（4700 = 47.00点）
      ymd(get("changeDate")) ?? fail(`変更年月日「${get("changeDate")}」を読めません`),
      get("endDate") === "99999999" ? "" : ymd(get("endDate")) ?? fail(`廃止年月日「${get("endDate")}」を読めません`),
    ]);
  });
  return { master: "fee", kind: "full", rows, skipped: { otherForms: 0, partialOtc: 0, noYjCode: 0 } };
}

function parseDrugRecords(records) {
  const kind = records.some((r) => r[F.changeKind - 1] === "0") ? "full" : "diff";

  const rows = [];
  const skipped = { otherForms: 0, partialOtc: 0, noYjCode: 0 };
  const seen = new Set();
  records.forEach((r, i) => {
    const line = i + 1;
    const fail = (message) => { throw new FileFormatError(`${line}行目：${message}`); };
    if (r.length !== FIELD_COUNT) fail(`項目が${r.length}個あります（医薬品マスターは${FIELD_COUNT}個）`);
    const get = (key) => r[F[key] - 1];
    if (get("masterType") !== "Y") fail("医薬品マスターの行ではありません（マスター種別が Y ではない）");
    const changeKind = get("changeKind");
    if (!["0", "1", "3", "5", "9"].includes(changeKind)) fail(`変更区分「${changeKind}」を読めません`);
    const code = get("code");
    if (!/^6\d{8}$/.test(code)) fail(`医薬品コード「${code}」が9桁ではありません`);

    // 改定分の変更行（3 以外）は剤形が空。内用薬かどうかは、取り込み済みの薬にあるかでサーバーが決める
    const full = kind === "full" || changeKind === "3";
    const form = get("dosageForm");
    if (full && form !== NAIYO) return skipped.otherForms++;
    // 長期収載品関連があるのに選定療養区分が 0 の行は、令和9年3月からの一部保険外療養（OTC 類似薬）のコード。計算に対応していない
    if (full && get("related") !== "0" && get("sentei") === "0") return skipped.partialOtc++;
    if (full && get("yjCode") === "") return skipped.noYjCode++;
    if (seen.has(code)) fail(`医薬品コード ${code} が2回出てきます`);
    seen.add(code);

    const opt = (key, parse) => (get(key) === "" ? null : parse(get(key)));
    const need = (key, parse) => (get(key) === "" ? fail(`${LABEL[key]}が空です`) : parse(get(key)));
    const pick = full ? need : opt;
    if (full && get("amountKind") !== "1") fail(`金額種別「${get("amountKind")}」の内用薬は扱えません`);

    const name = pick("name", (v) => v);
    const generalName = full ? get("generalName") : opt("generalName", (v) => v);
    rows.push([
      line,
      changeKind,
      code,
      pick("yjCode", (v) => v),
      name,
      // 単位が空（単位コード 0）の薬は、薬価が規格単位（例：２０，０００単位）1つ当たり
      full ? get("unitName").normalize("NFKC") : opt("unitName", (v) => v.normalize("NFKC")),
      pick("generic", (v) => (v === "1" ? 1 : v === "0" ? 0 : fail(`後発品「${v}」を読めません`))),
      generalName,
      generalName === null ? null : searchKey(generalName.replace(/^【般】/, "")),
      name === null ? null : searchKey(name),
      pick("sentei", (v) => (["0", "1", "2"].includes(v) ? Number(v) : fail(`選定療養区分「${v}」を読めません`))),
      pick("related", (v) => (v === "0" ? "" : /^6\d{8}$/.test(v) ? v : fail(`長期収載品関連「${v}」を読めません`))),
      pick("price", (v) => yenToSen(v) ?? fail(`金額「${v}」が小数第2位までの金額ではありません`)),
      need("changeDate", (v) => ymd(v) ?? fail(`変更年月日「${v}」を読めません`)),
      opt("endDate", (v) => (v === "99999999" ? "" : ymd(v) ?? fail(`廃止年月日「${v}」を読めません`))),
      opt("transitional", (v) => (v === "0" ? "" : ymd(v) ?? fail(`経過措置年月日「${v}」を読めません`))),
      pick("narcotic", (v) => (["0", "1", "2", "3", "5"].includes(v) ? Number(v) : fail(`麻薬・毒薬・覚醒剤原料・向精神薬「${v}」を読めません`))),
    ]);
  });
  return { master: "drug", kind, rows, skipped }; // rows が空のこともある（外用薬・注射薬だけの改定分）
}

// "9.50" → 950。マスターの金額は小数点以下2桁で書かれている。小数のまま計算しないよう文字列で分ける
function yenToSen(text) {
  const m = text.match(/^(\d{1,10})\.(\d{2})$/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

// "20261101" → "2026-11-01"。実在しない日付は null
function ymd(text) {
  if (!/^\d{8}$/.test(text)) return null;
  const s = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

function dateInFileName(name) {
  const m = name.match(/(\d{8})\.(zip|csv)$/i); // y_ALL20261013.zip・y_20261013.csv・m20260911.csv
  return m ? ymd(m[1]) : null;
}

// RFC 4180 の CSV。改行は CRLF / LF のどちらでもよい。最後の空行は捨てる
function parseCsv(text) {
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new FileFormatError("CSV の引用符が閉じていません");
  if (field !== "" || row.length > 0) { row.push(field); records.push(row); }
  return records;
}
