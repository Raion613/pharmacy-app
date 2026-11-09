// お薬手帳に出すもの。紙の手帳に貼る内容と、電子版お薬手帳に読み込ませるデータ（QR コード）を、同じ処方から作る。
//
// 電子版のデータは JAHIS「電子版お薬手帳データフォーマット仕様書 Ver.2.0」（JAHISTC03）。
//   Shift_JIS のテキスト。1行が1レコードで、先頭がレコード番号、項目はカンマ区切り、行末は CR LF。
//   使うレコード：バージョン、1 患者情報、5 調剤等年月日、11 調剤－医療機関等、15 調剤－医師・薬剤師、201 薬品、301 用法
const CRLF = "\r\n";
const JAHIS_VERSION = "JAHISTC03";

// 処方（薬歴の1件）と患者・薬局から、電子版お薬手帳のテキストを作る
export function jahisText({ patient, pharmacy, prescription }) {
  const ymd = (d) => d.replaceAll("-", "");
  const lines = [
    `${JAHIS_VERSION},1`,
    // 患者氏名・性別（1 男、2 女）・生年月日、住所など（省略）、患者氏名カナ
    record(1, patient.name, patient.sex === "M" ? 1 : 2, ymd(patient.birthDate), "", "", "", "", "", "", patient.kana),
    record(5, ymd(prescription.dispensedOn), 1),
    // 薬局名・都道府県・点数表（4 調剤）・薬局コード・郵便番号・住所・電話
    record(11, pharmacy.name, pharmacy.prefectureCode, 4, pharmacy.pharmacyCode, pharmacy.postalCode, pharmacy.address, pharmacy.phone, 1),
    record(15, prescription.createdBy, pharmacy.phone, 1),
  ];
  for (const rp of prescription.rps) {
    for (const it of rp.items) {
      // RP 番号・薬品名・1日量・単位・コード種別（2 レセプト電算コード）・医薬品コード
      lines.push(record(201, rp.rpNo, it.name, quantityText(it.dailyQtyMilli), it.unit === "" ? "規格単位" : it.unit, 2, it.drugCode, 1));
    }
    // RP 番号・用法・調剤数量（日数）・調剤単位・剤型（1 内服）・用法コード種別（1 コードなし）
    lines.push(record(301, rp.rpNo, rp.usage, rp.days, "日分", 1, 1, "", 1));
  }
  return lines.join(CRLF) + CRLF;
}

// 項目の中の半角カンマは区切りと紛れるので全角にする（仕様書 3.2.5）
function record(no, ...fields) {
  return [no, ...fields.map((f) => String(f).replaceAll(",", "，"))].join(",");
}

// 1500 → "1.5"（整数の前と小数の後の 0 は書かない）
function quantityText(milli) {
  const int = Math.floor(milli / 1000);
  const frac = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : String(int);
}

// ---------- Shift_JIS への変換 ----------
// ブラウザの TextEncoder は UTF-8 しか作れない。TextDecoder("shift_jis") で全部の2バイト文字を読んで、逆引きの表を作る。
// 表に無い文字（外字・絵文字など）は、仕様書のとおり「■」（0x81A1）にする。
let table = null;

export function toShiftJis(text) {
  if (table === null) table = buildTable();
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code >= 0xff61 && code <= 0xff9f) out.push(code - 0xff61 + 0xa1); // 半角カナ
    else {
      const sjis = table.get(ch) ?? 0x81a1;
      out.push(sjis >> 8, sjis & 0xff);
    }
  }
  return new Uint8Array(out);
}

function buildTable() {
  const decoder = new TextDecoder("shift_jis");
  const map = new Map();
  // JIS X 0208 の範囲だけ（仕様書 3.2.5）。NEC 特殊文字（0x87）や IBM 拡張文字（0xED〜）などの機種依存文字は使わない
  for (const lead of [...range(0x81, 0x84), ...range(0x88, 0x9f), ...range(0xe0, 0xea)]) {
    for (const trail of [...range(0x40, 0x7e), ...range(0x80, 0xfc)]) {
      const ch = decoder.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== "\uFFFD" && !map.has(ch)) map.set(ch, (lead << 8) | trail);
    }
  }
  return map;
}

function* range(from, to) {
  for (let i = from; i <= to; i++) yield i;
}
