// 文字の揺れを揃える。ブラウザ・サーバー・取り込みスクリプトで共通に使う。

// 全角英数→半角、半角カナ→全角（NFKC）、ひらがな→カタカナ、英字は大文字、空白は除く。
// 「ろきそにん」「ﾛｷｿﾆﾝ」「ロキソニン」が同じキーになる。
export function searchKey(text) {
  return toKatakana(String(text).normalize("NFKC")).toUpperCase().replace(/\s+/g, "");
}

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
