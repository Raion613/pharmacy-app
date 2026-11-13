// 文字の揺れを揃える。ブラウザ・サーバー・取り込みスクリプトで共通に使う。

// 全角英数→半角、半角カナ→全角（NFKC）、ひらがな→カタカナ、英字は大文字、空白は除く。濁点・半濁点も外す。
// 「ろきそにん」「ﾛｷｿﾆﾝ」「ロキソニン」が同じキーになる。「はるぷろ」「ぱるぷろ」「ばるぷろ」も同じキー（打ち間違えても候補に出す）
export function searchKey(text) {
  return dropVoicing(toKatakana(String(text).normalize("NFKC")).toUpperCase().replace(/\s+/g, ""));
}

// 濁点・半濁点を外す（バ・パ → ハ、ヴ → ウ）。分解すると「ハ＋濁点の記号」になるので、記号だけ消して戻す
const VOICING_MARKS = new RegExp(`[${String.fromCharCode(0x3099, 0x309a)}]`, "g"); // 結合用の濁点・半濁点（U+3099・U+309A）
function dropVoicing(s) {
  return s.normalize("NFD").replace(VOICING_MARKS, "").normalize("NFC");
}

// 濁点・半濁点の付くカタカナと、外した字の組（ガ → カ …）。DB の中の文字を SQL で揃えるときに使う
export const VOICED_KATAKANA = [...Array(0x30F6 - 0x30A1 + 1)].map((_, i) => String.fromCharCode(0x30A1 + i))
  .filter((c) => dropVoicing(c) !== c).map((c) => [c, dropVoicing(c)]);

// 患者のカナ：NFKC＋ひらがな→カタカナ。空白は全角1つに揃える（姓と名の区切り）。
export function normalizeKana(text) {
  return toKatakana(String(text).normalize("NFKC")).trim().replace(/\s+/g, "　");
}

export function isKatakana(text) {
  return /^[ァ-ヶー　]+$/.test(text);
}

function toKatakana(s) {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}
