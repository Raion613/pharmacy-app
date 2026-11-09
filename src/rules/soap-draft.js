// 会話の文字起こしと処方から、指導記録（SOAP）の下書きを組み立てる。会話から患者メモの候補（既往歴・アレルギーなど）も拾う。
// kusudamaクラウド薬歴では AI がする部分を、ここでは決まった規則でする。
//   S：患者・家族の発言
//   O：処方の変化、最近の検査値、残薬についての発言
//   A：指導内容の提案（guidance-suggest.js）のうち、評価の文があるもの
//   P：指導内容の提案の文
// 下書きは薬剤師が直してから保存する。下書きのまま保存しても「下書きから書いた」印が残る。
//
// 文字起こしは1行1発言で「話者：発言」の形（話者は 薬剤師／患者／家族）。

const SPEAKER = /^(薬剤師|患者|家族)[：:]\s*(.*)$/;
const RECENT_DAYS = 90;

export function parseTranscript(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = line.match(SPEAKER);
    return m ? { speaker: m[1], text: m[2] } : { speaker: null, text: line };
  });
}

const sentences = (text) => text.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);

function patientSentences(lines) {
  return lines.filter((l) => l.speaker === "患者" || l.speaker === "家族")
    .flatMap((l) => sentences(l.text).map((s) => ({ speaker: l.speaker, text: s })));
}

const LEFTOVER_WORDS = /残っ|余っ|飲み忘れ|残薬/;

// { transcript, changes: ["＋追加 …", …], labs: [{ label, text, measuredOn }], suggestions, on }
export function buildDraft({ transcript, changes, labs, suggestions, on }) {
  const said = patientSentences(parseTranscript(transcript));
  const subjective = said.filter((s) => !LEFTOVER_WORDS.test(s.text))
    .map((s) => (s.speaker === "家族" ? `（家族）${s.text}` : s.text)).join("");

  const objective = [];
  if (changes.length) objective.push(`処方：${changes.join("、")}`);
  const recentLabs = labs.filter((l) => daysBetween(l.measuredOn, on) <= RECENT_DAYS);
  if (recentLabs.length) objective.push(`検査値：${recentLabs.map((l) => `${l.label} ${l.text}（${l.measuredOn.slice(5).replace("-", "/")}）`).join("、")}`);
  const leftoverTalk = said.filter((s) => LEFTOVER_WORDS.test(s.text));
  if (leftoverTalk.length) objective.push(`残薬：${leftoverTalk.map((s) => `「${s.text}」`).join("")}`);

  const assessment = [...new Set(suggestions.map((s) => s.assessment).filter(Boolean))].join("。");
  const plan = [...new Set(suggestions.map((s) => s.plan))].join("。");
  const leftover = leftoverTalk.some((s) => /残っ|余っ/.test(s.text) && !/残っていない|余っていない|ありません/.test(s.text)) ? "some" : "unchecked";
  return {
    subjective,
    objective: objective.join("\n"),
    assessment: assessment ? `${assessment}。` : "",
    plan: plan ? `${plan}。` : "",
    leftover,
  };
}

function daysBetween(a, b) {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
}

// 会話から患者メモの候補を拾う。患者・家族の発言の文単位で、分類ごとの言葉が入っているものを返す（否定の文は除く）。
const EXTRACT_RULES = [
  { category: "allergy", words: /発疹|じんましん|蕁麻疹|かゆみ|息苦し|腫れ|アレルギー/ },
  { category: "disease", words: /高血圧|血圧が高|糖尿病|喘息|ぜんそく|胃潰瘍|腎臓|緑内障|前立腺|狭心症|心臓|コレステロール|痛風|甲状腺|治療中|治療をして|通院して/ },
  { category: "concomitant", words: /サプリ|市販|ドラッグストア|健康食品|青汁|胃腸薬/ },
  { category: "lifestyle", words: /たばこ|タバコ|喫煙|お酒|飲酒|ビール|車の運転/ },
];
const NEGATIVE = /ありません|ないです|無いです|特にない|していません|飲んでいません/;

export function extractNotes(transcript) {
  const out = [];
  for (const s of patientSentences(parseTranscript(transcript))) {
    if (NEGATIVE.test(s.text)) continue;
    const rule = EXTRACT_RULES.find((r) => r.words.test(s.text));
    if (rule) out.push({ category: rule.category, body: `${s.speaker === "家族" ? "（家族より）" : ""}${s.text}（服薬指導の会話より）` });
  }
  return out;
}
