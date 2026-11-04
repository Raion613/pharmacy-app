// 患者メモの分類と、指導記録の選択肢。画面とサーバーで共通に使う。
//
// 分類は、服薬管理指導料の通知（通則(4)ウ・エ）が薬剤服用歴に記載を求める項目に合わせた。
//   (イ) 体質（アレルギー歴、副作用歴等）、生活状況、後発医薬品の使用に関する意向
//   (ロ) 疾患に関する情報（既往歴、合併症、他科受診）
//   (ハ) 併用薬（要指導・一般用医薬品、健康食品を含む）、相互作用のある飲食物の摂取状況
//   エ  今後の継続的な薬学的管理・指導の留意点 → 申し送り
// 並び順は、来局時に最初に確かめたい順（体質 → 疾患 → 併用薬 → 生活 → 意向 → 申し送り）。

export const NOTE_CATEGORIES = [
  { key: "allergy", label: "アレルギー歴", alert: true },
  { key: "adverse", label: "副作用歴", alert: true },
  { key: "disease", label: "疾患（既往歴・合併症・他科）", alert: false },
  { key: "concomitant", label: "併用薬（OTC・健康食品を含む）", alert: false },
  { key: "lifestyle", label: "生活状況・飲食物", alert: false },
  { key: "generic", label: "後発医薬品の意向", alert: false },
  { key: "handover", label: "申し送り", alert: false },
];

export const NOTE_LABEL = Object.fromEntries(NOTE_CATEGORIES.map((c) => [c.key, c.label]));
export const ALERT_CATEGORIES = NOTE_CATEGORIES.filter((c) => c.alert).map((c) => c.key);

// 指導記録の S・O・A・P
export const SOAP = [
  { key: "subjective", letter: "S", label: "患者の訴え・相談" },
  { key: "objective", letter: "O", label: "服薬状況・検査値など" },
  { key: "assessment", letter: "A", label: "薬剤師の評価" },
  { key: "plan", letter: "P", label: "指導内容・次回の留意点" },
];

export const LEFTOVER = { none: "残薬なし", some: "残薬あり", unchecked: "残薬未確認" };
export const NOTEBOOK = { used: "手帳あり", not_used: "手帳なし", unchecked: "手帳未確認" };

export const NOTE_MAX = 300;
export const SOAP_MAX = 1000;
