// 薬歴：再来局した患者を開いたときに、この人について知っておくべきことを1画面で見渡す。
//   箱：患者・注意点（アレルギー歴・副作用歴・疾患・併用薬）・次に確認すること（前回の P・申し送り）・今の処方・生活・検査値
//   箱「処方の推移」：薬 × 来局日の表。いつ始まり・変わり・止まったか
//   箱「経過」：全来局を新しい順に。並べ方は「折り返し」か「1〜3段の帯（左が新しい）」を選べる。選んだ来局だけ処方の中身と操作を出す
//   箱の並び順と大きさは「配置を変える」で利用者ごとに変えられる（layout-grid.js）
//   指導記録を書く画面の右側：服薬指導の会話の録音と文字起こし、会話から拾った患者メモの候補、指導内容の提案、
//   つながる薬局で届いたメッセージ。左の S・O・A・P には、下書き（会話と処方から組み立てた文）とテンプレートを写せる
import {
  renderShell, api, ApiError, escapeHtml, formatDate, formatDateTime, birthText, SEX, priceText, pointsText,
  unitText, toast,
} from "./app.js";
import { setupLayout } from "./layout-grid.js";
import { setupMemoPad, memoText, memoMeta } from "./memo-pad.js";
import { openOverlay } from "./overlay.js";
import { dailyCost, formatYen, formatSen, formatQuantity } from "./yakuzairyo.js";
import { NOTE_CATEGORIES, NOTE_LABEL, SOAP, LEFTOVER, NOTEBOOK, NOTE_MAX } from "./record-kinds.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";
import { icon } from "./icons.js";
import { LAB_ITEMS, LAB, labText, latestByItem, formatLabValue } from "./lab-items.js";
import { suggestGuidance } from "./guidance-suggest.js";
import { buildDraft, extractNotes } from "./soap-draft.js";

const SECTION = { tech: "調剤技術料", mgmt: "薬学管理料", other: "その他" };
const HANDBOOK = { paper: "提示あり（紙）", electronic: "提示あり（電子版）", none: "提示なし" };
const CHANGE_REASON = { general: "一般名処方の銘柄を選んだ", generic: "後発品に変更した", inquiry: "疑義照会で変わった" };
const DAYS_CHANGE = { inquiry: "疑義照会で減らした", instruction: "処方箋の指示で減らした" };
const INQUIRY_KIND = { leftover: "残薬調整", adverse: "重複投薬・相互作用など" };

const params = new URLSearchParams(location.search);
const patientId = params.get("id");
const savedId = params.get("saved");

renderShell({ page: "patients", title: "薬歴", back: { label: "患者一覧", href: "/patients" } });

// prescriptions は新しい順（調剤日の降順）でサーバーから来る
const { patient, notes, prescriptions, measurements, messages, memo } = await api(`/api/patients/${patientId}`);

// 上の帯：どの患者の薬歴かを大きく出す
document.querySelector("#subject").innerHTML = `<span class="subject-name">${escapeHtml(patient.name)}</span>
  <span class="subject-kana">${escapeHtml(patient.kana)}</span><span class="subject-facts">${birthText(patient.birthDate)}・${SEX[patient.sex]}・${escapeHtml(patient.patientNo)}</span>`;
document.title = `薬歴 ${patient.name} | 薬剤料計算・薬歴`;
const tracingHref = (rx) => `/tracing?patient=${patient.id}${rx ? `&rx=${rx.id}` : ""}`;

const band = document.querySelector("#band");
const cautionsEl = document.querySelector("#cautions");
const nextEl = document.querySelector("#next");
const medsEl = document.querySelector("#current-meds");
const otherEl = document.querySelector("#other");
const labsEl = document.querySelector("#labs");
// 初期の配置。並び順に左上から詰める（12列）。左に患者・検査値・メモ帳、その右に注意点・次に確認すること・今の処方、
// その下に処方の推移、いちばん下に経過（下へいくらでも伸びる）
const layout = setupLayout({
  grid: document.querySelector("#pt-grid"),
  page: "patient",
  editButton: document.querySelector("#layout-edit"),
  resetButton: document.querySelector("#layout-reset"),
  defaults: {
    boxes: [
      { id: "patient", w: 2, h: 1 },
      { id: "cautions", w: 4, h: 3 },
      { id: "next", w: 3, h: 2 },
      { id: "meds", w: 3, h: 3 },
      { id: "labs", w: 2, h: 1 },
      { id: "memo", w: 2, h: 1 },
      { id: "other", w: 3, h: 1 },
      { id: "matrix", w: 12, h: 1 },
      { id: "history", w: 12, h: 1 },
    ],
    options: { historyRows: 0, matrixFold: 0 },
  },
  onOptions: (options) => {
    applyShape(options.historyRows);
    applyMatrixFold(options.matrixFold);
  },
});
const timeline = document.querySelector("#timeline");
const matrixView = document.querySelector("#matrix-view");
// 操作の帯のうち、選んでいる来局に対して働くボタン
const visitButtons = ["#do-rx", "#write-record", "#open-receipt", "#open-handbook", "#open-inspect"].map((s) => document.querySelector(s));
const visitLabel = document.querySelector("#visit-label");
let selectedIndex = -1;

// ---------- 処方の比較 ----------

// 来局の薬を 薬コード → { 名前, 1日量, 用法, 日数 } にする
function drugsOf(rx) {
  const map = new Map();
  for (const rp of rx.rps) {
    for (const it of rp.items) {
      map.set(it.drugCode, { code: it.drugCode, name: it.name, unit: it.unit, qty: it.dailyQtyMilli, usage: rp.usage, days: rp.days });
    }
  }
  return map;
}

const qtyText = (d) => `${formatQuantity(d.qty)}${d.unit}`;

// 前回の来局と比べた処方の変化。前回が無ければ「初回」
function changesOf(index) {
  const prev = prescriptions[index + 1];
  if (!prev) return [{ kind: "first", text: "この薬局で初めての処方" }];
  const now = drugsOf(prescriptions[index]);
  const before = drugsOf(prev);
  const changes = [];
  for (const d of now.values()) {
    const b = before.get(d.code);
    if (!b) {
      changes.push({ kind: "add", code: d.code, name: d.name, text: `${qtyText(d)}・${d.days}日分` });
      continue;
    }
    const diffs = [];
    if (b.qty !== d.qty) diffs.push(`1日量 ${qtyText(b)}→${qtyText(d)}`);
    if (b.usage !== d.usage) diffs.push(`用法 ${b.usage}→${d.usage}`);
    if (b.days !== d.days) diffs.push(`日数 ${b.days}→${d.days}日分`);
    if (diffs.length) changes.push({ kind: "mod", code: d.code, name: d.name, text: diffs.join("、") });
  }
  for (const b of before.values()) {
    if (!now.has(b.code)) changes.push({ kind: "stop", code: b.code, name: b.name, text: "" });
  }
  return changes.length ? changes : [{ kind: "same", text: "前回と同じ処方" }];
}

const CHANGE_LABEL = { add: "＋追加", stop: "−中止", mod: "変更", same: "", first: "" };

function changesHtml(changes) {
  return changes.map((c) => `<span class="change ${c.kind}">${CHANGE_LABEL[c.kind] ? `<b>${CHANGE_LABEL[c.kind]}</b>` : ""}${
    c.name ? escapeHtml(c.name) : ""}${c.text ? ` ${escapeHtml(c.text)}` : ""}</span>`).join("");
}

// index 番目以前（それより古い来局を含む）で、いちばん新しい指導記録
function latestRecordFrom(index) {
  for (let i = index; i < prescriptions.length; i++) {
    if (prescriptions[i].records.length) return { record: prescriptions[i].records[0], rx: prescriptions[i] };
  }
  return null;
}

// ---------- 上：患者・注意点・次に確認すること・今の処方・生活・検査値 ----------
// 箱の置き場所と大きさは利用者が変えられる（layout-grid.js）

const notesOf = (key) => notes.filter((n) => n.category === key);
const noteItems = (key, newNoteId) => notesOf(key).map((n) => `<li class="${n.id === newNoteId ? "new" : ""}">${escapeHtml(n.body)}<span class="meta">${
  formatDate(n.createdAt.slice(0, 10))} ${escapeHtml(n.createdBy)}</span></li>`).join("");

// 患者：氏名と、来局時に確かめる基本の事実
function renderBand() {
  band.innerHTML = `
    <div class="kana">${escapeHtml(patient.kana)}</div>
    <div class="name">${escapeHtml(patient.name)}</div>
    <dl class="facts">
      <div><dt>生年月日</dt><dd>${birthText(patient.birthDate)}</dd></div>
      <div><dt>性別</dt><dd class="sex-${patient.sex}">${SEX[patient.sex]}</dd></div>
      <div><dt>負担</dt><dd>${patient.burdenPercent / 10}割</dd></div>
      <div><dt>患者番号</dt><dd class="num">${escapeHtml(patient.patientNo)}</dd></div>
      <div><dt>最終来局</dt><dd>${patient.lastDispensedOn ? formatDate(patient.lastDispensedOn) : "—"}</dd></div>
    </dl>`;
}

// 注意点：アレルギー歴・副作用歴・疾患・併用薬を1つの表に。赤はアレルギー歴・副作用歴だけ
const CAUTION_KEYS = ["allergy", "adverse", "disease", "concomitant"];
const CAUTION_LABEL = { allergy: "アレルギー", adverse: "副作用", disease: "疾患", concomitant: "併用薬" };

function renderCautions(newNoteId) {
  cautionsEl.innerHTML = `<table class="cautions">${CAUTION_KEYS.map((key) => {
    const items = noteItems(key, newNoteId);
    const alert = items && NOTE_CATEGORIES.find((c) => c.key === key).alert;
    return `<tr data-category="${key}" class="${alert ? "alert" : ""}"><th>${CAUTION_LABEL[key]}</th>
      <td>${items ? `<ul>${items}</ul>` : '<span class="none">記録なし</span>'}</td></tr>`;
  }).join("")}</table>`;
}

// 次に確認すること：前回の指導記録の P と、申し送り
function renderNext(newNoteId) {
  const last = latestRecordFrom(0);
  const handover = noteItems("handover", newNoteId);
  nextEl.innerHTML = (last && last.record.plan
    ? `<section class="last-plan" id="last-plan"><h3>前回の留意点（P）<span class="sub">${formatDate(last.rx.dispensedOn)} ${escapeHtml(last.record.createdBy)}</span></h3>
        <p>${escapeHtml(last.record.plan)}</p></section>`
    : "")
    + `<section data-category="handover"><h3>申し送り</h3>${handover ? `<ul>${handover}</ul>` : '<span class="none">記録なし</span>'}</section>`;
}

// 今の処方：最終来局の薬と、いつから続いているか（同じ薬が途切れずに出ている最初の来局）
function renderMeds() {
  if (prescriptions.length === 0) {
    medsEl.innerHTML = '<span class="none">来局の記録なし</span>';
    return;
  }
  const latest = prescriptions[0];
  document.querySelector("#meds-date").textContent = formatDate(latest.dispensedOn);
  medsEl.innerHTML = `<ul class="meds">${[...drugsOf(latest).values()].map((d) => {
    let i = 0;
    while (i + 1 < prescriptions.length && drugsOf(prescriptions[i + 1]).has(d.code)) i++;
    const recent = i === 0 && prescriptions.length > 1;
    return `<li><span class="name">${escapeHtml(d.name)}</span><span class="dose">${qtyText(d)}</span>
      <span class="since ${recent ? "recent" : ""}">${escapeHtml(d.usage)} ／ ${recent ? "最終来局で追加" : `${formatDate(prescriptions[i].dispensedOn)}から（${i + 1}回）`}</span></li>`;
  }).join("")}</ul>`;
}

// 生活状況と後発品の意向
function renderOther(newNoteId) {
  otherEl.innerHTML = ["lifestyle", "generic"].map((key) => {
    const items = noteItems(key, newNoteId);
    return `<section data-category="${key}"><h3>${escapeHtml(NOTE_LABEL[key])}</h3>${items ? `<ul>${items}</ul>` : '<span class="none">記録なし</span>'}</section>`;
  }).join("");
}

// 検査値：項目ごとの最新の値と測定日。前回の値があれば矢印で増減を添える
function renderLabs() {
  const rows = LAB_ITEMS.map((item) => {
    const list = measurements.filter((m) => m.item === item.key); // 新しい順
    if (list.length === 0) return "";
    const [now, before] = list;
    const trend = before === undefined ? "" : now.valueMilli > before.valueMilli ? "↑" : now.valueMilli < before.valueMilli ? "↓" : "→";
    return `<li><span class="name">${escapeHtml(item.label)}</span><span class="num value">${labText(item.key, now.valueMilli)}${trend
      ? `<span class="trend" title="前回 ${labText(item.key, before.valueMilli)}（${formatDate(before.measuredOn)}）">${trend}</span>` : ""}</span>
      <span class="since">${formatDate(now.measuredOn)}${now.source === "photo" ? "・用紙から" : ""}</span></li>`;
  }).join("");
  labsEl.innerHTML = rows ? `<ul class="labs">${rows}</ul>` : '<span class="none">記録なし</span>';
}

function renderSummary(newNoteId = null) {
  renderCautions(newNoteId);
  renderNext(newNoteId);
  renderMeds();
  renderOther(newNoteId);
  renderLabs();
  if (newNoteId !== null) document.querySelector("li.new").scrollIntoView({ block: "nearest" });
}

// ---------- 中央：経過 ----------

function renderTimeline() {
  document.querySelector("#visit-count").textContent = `来局 ${prescriptions.length}回`;
  if (prescriptions.length === 0) {
    timeline.innerHTML = '<p class="empty">まだ来局の記録がありません。<br><kbd>Alt</kbd>+<kbd>N</kbd> で今日の処方を入力できます。</p>';
    return;
  }
  timeline.innerHTML = prescriptions.map((rx, i) => cardHtml(rx, i)).join("");
  for (const card of timeline.querySelectorAll(".visit-card")) {
    const i = Number(card.dataset.index);
    card.querySelector(".vc-head").addEventListener("click", () => select(i));
    card.addEventListener("focusin", () => select(i, false));
    for (const b of card.querySelectorAll("[data-action=record]")) b.addEventListener("click", () => openRecordDialog(i));
    card.querySelector("[data-action=calc]").addEventListener("click", (e) => {
      const calc = card.querySelector(".vc-calc");
      calc.hidden = !calc.hidden;
      e.currentTarget.textContent = calc.hidden ? "計算の内訳を見る" : "計算の内訳を閉じる";
      e.currentTarget.setAttribute("aria-expanded", String(!calc.hidden));
    });
  }
  if (selectedIndex >= 0) select(selectedIndex, false);
}

function cardHtml(rx, i) {
  const changes = changesOf(i);
  const changed = new Map(changes.filter((c) => c.code).map((c) => [c.code, c.kind]));
  const rpHtml = rx.rps.map((rp) => `
    <div class="vc-rp">
      <div class="rp-line"><b>Rp${rp.rpNo}</b>${escapeHtml(rp.usage)}・${rp.days}日分${rp.days === rp.rxDays ? ""
        : `<span class="rx-was" title="処方箋の日数から減らして調剤した">処方箋 ${rp.rxDays}日分 → ${DAYS_CHANGE[rp.daysChange]}</span>`}</div>
      <ul>${rp.items.map((it) => `<li class="${changed.get(it.drugCode) === "add" ? "added" : changed.get(it.drugCode) === "mod" ? "modified" : ""}">
        <span>${escapeHtml(it.name)}${it.rx ? `<span class="rx-was">処方箋：${escapeHtml(it.rx.name)} ${formatQuantity(it.rx.dailyQtyMilli)}${escapeHtml(unitText(it.unit))}（${CHANGE_REASON[it.rx.reason]}）</span>` : ""}</span>
        <span class="qty">${formatQuantity(it.dailyQtyMilli)}${escapeHtml(unitText(it.unit))}</span></li>`).join("")}</ul>
    </div>`).join("") + (rx.inquiries.length === 0 ? "" : `
    <div class="vc-inquiries"><b>疑義照会</b>${rx.inquiries.map((q) => `
      <div class="vc-inquiry"><span class="tag ${q.changed ? "tag-warn" : ""}">${INQUIRY_KIND[q.kind]}・${q.changed ? "処方変更あり" : "変更なし"}</span>
        <div>${escapeHtml(q.content)}</div><div class="answer">回答：${escapeHtml(q.answer)}</div></div>`).join("")}
    </div>`);
  const conversations = rx.conversations.map((c) => `<details class="conv"><summary>${icon("mic", 14)}服薬指導の会話（${c.durationSec}秒・${
    c.source === "file" ? `ファイル ${escapeHtml(c.fileName)}` : "録音"}）<span class="meta">${escapeHtml(c.createdBy)} ${formatDateTime(c.createdAt)}</span></summary>
    <div class="transcript">${transcriptHtml(c.transcript)}</div></details>`).join("");
  const records = conversations + (rx.records.length
    ? rx.records.map(recordHtml).join("")
    : `<div class="no-record">${icon("alert", 16)}指導記録 未記載<button type="button" class="btn btn-small btn-primary" data-action="record">記載する</button></div>`);
  return `<article class="visit-card" data-index="${i}" data-id="${rx.id}" aria-selected="false">
    <header class="vc-head">
      <span class="vc-date">${formatDate(rx.dispensedOn)}</span>
      <span class="vc-points num" title="薬剤料（1点＝10円）">薬剤料 ${pointsText(rx.drugPoints)}</span>
      <span class="vc-total num" title="調剤技術料・薬学管理料・薬剤料・その他の合計と、窓口で受け取った額">合計 ${pointsText(rx.totalPoints)}・窓口 ${(rx.copayYen + (rx.specialFeeYen ?? 0)).toLocaleString()}円</span>
      ${rx.specialFeeYen === null ? "" : `<span class="tag tag-warn" title="長期収載品の選定療養。保険とは別に患者から受け取った額（消費税込み）">特別の料金 ${rx.specialFeeYen.toLocaleString()}円</span>`}
      <span class="spacer"></span>
      <span class="meta">入力 ${escapeHtml(rx.createdBy)}</span>
    </header>
    <div class="vc-changes">${changesHtml(changes)}</div>
    <div class="vc-body">
      <div class="vc-rx">${rpHtml}</div>
      <div class="vc-records">${records}</div>
    </div>
    <div class="vc-foot">
      <button type="button" class="btn btn-ghost btn-small" data-action="calc" aria-expanded="false">計算の内訳を見る</button>
    </div>
    <div class="vc-calc" hidden>${rx.rps.map(calcHtml).join("")}
      <table class="fee-lines">${rx.fees.map((f) => `<tr><td>${SECTION[f.section]}</td><td>${escapeHtml(f.name)}</td>
        <td class="num">${f.points}点${f.count > 1 ? ` × ${f.count}` : ""}</td><td class="num">${pointsText(f.points * f.count)}</td></tr>`).join("")}
        <tr><td>薬剤料</td><td>剤ごとの合計（上の表）</td><td></td><td class="num">${pointsText(rx.drugPoints)}</td></tr></table>
      <div class="rp-foot">処方日 ${formatDate(rx.prescribedOn)} ／ 入力 ${formatDateTime(rx.createdAt)} ／ 合計 <strong>${pointsText(rx.totalPoints)}</strong> ／
        一部負担金（${rx.burdenPercent / 10}割）<strong>${rx.copayYen.toLocaleString()}円</strong> ／ お薬手帳 ${HANDBOOK[rx.handbook]}</div>
      ${rx.specialFeeYen === null ? "" : `<div class="rp-foot">特別の料金（選定療養）：${rx.specialFeeMethod === "points"
        ? `価格差を剤ごとに点数にして × 10円 ＋ 消費税`
        : `価格差 × 投薬全量を10円単位にして ＋ 消費税`} = <strong>${rx.specialFeeYen.toLocaleString()}円</strong></div>`}
    </div>
  </article>`;
}

function recordHtml(g) {
  const rows = SOAP.filter(({ key }) => g[key]).map(({ key, letter, label }) =>
    `<dt class="${letter === "P" ? "p" : ""}" title="${escapeHtml(label)}">${letter}</dt><dd class="${letter === "P" ? "p" : ""}">${escapeHtml(g[key])}</dd>`).join("");
  return `<article class="record" data-id="${g.id}">
    <dl class="soap">${rows}</dl>
    <div class="record-meta"><span class="tag ${g.leftover === "some" ? "tag-warn" : ""}">${LEFTOVER[g.leftover]}</span><span class="tag">${NOTEBOOK[g.notebook]}</span>${
      g.drafted ? '<span class="tag" title="会話の文字起こし・処方から組み立てた下書きを元に書いた記録">下書きから</span>' : ""}
      <span>${escapeHtml(g.createdBy)} ${formatDateTime(g.createdAt)}</span></div>
  </article>`;
}

function calcHtml(rp) {
  const rows = rp.items.map((it) => {
    const cost = formatYen(dailyCost([{ priceSen: it.priceSen, dailyQtyMilli: it.dailyQtyMilli }]));
    const diff = it.diffSen === null ? "" : `<span class="spec">価格差 ${formatSen(it.diffSen)}円</span>`;
    return `<tr><td>${escapeHtml(it.name)}${diff}</td>
      <td class="num">1日 ${formatQuantity(it.dailyQtyMilli)}${escapeHtml(unitText(it.unit))}</td>
      <td class="num">${priceText(it.priceSen, it.unit)}</td><td class="num">${cost}円</td></tr>`;
  }).join("");
  return `<section class="rp"><table>${rows}</table>
    <div class="rp-foot">Rp${rp.rpNo}：1日分 ${rp.dailyYen}円 → ${rp.pointsPerDay}点 × ${rp.days}日 = <strong class="num">${pointsText(rp.points)}</strong>${rp.specialPoints === null ? "" : `（特別の料金 ${pointsText(rp.specialPoints)}）`}</div></section>`;
}

function transcriptHtml(text) {
  return text.split("\n").map((line) => {
    const m = line.match(/^(薬剤師|患者|家族)：(.*)$/);
    return m ? `<p class="${m[1] === "薬剤師" ? "ph" : "pt"}"><b>${m[1]}</b>${escapeHtml(m[2])}</p>` : `<p>${escapeHtml(line)}</p>`;
  }).join("");
}

function select(i, scroll = true) {
  selectedIndex = i;
  visitLabel.textContent = `選んだ来局 ${formatDate(prescriptions[i].dispensedOn)}`;
  for (const b of visitButtons) b.disabled = false;
  for (const card of timeline.querySelectorAll(".visit-card")) {
    const on = Number(card.dataset.index) === i;
    card.setAttribute("aria-selected", String(on));
    if (on && scroll) card.scrollIntoView({ block: "nearest" });
  }
}

timeline.addEventListener("keydown", (e) => {
  if (prescriptions.length === 0 || e.target !== timeline) return;
  const last = prescriptions.length - 1;
  const next = { ArrowDown: selectedIndex + 1, ArrowRight: selectedIndex + 1, ArrowUp: selectedIndex - 1, ArrowLeft: selectedIndex - 1, Home: 0, End: last }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  select(Math.max(0, Math.min(last, next)));
});

// ---------- 中央：処方の推移（薬 × 来局日） ----------

let matrixFold = 0;
function renderMatrix() {
  if (prescriptions.length === 0) {
    matrixView.innerHTML = '<p class="empty">まだ来局の記録がありません。</p>';
    return;
  }
  const visits = [...prescriptions].reverse(); // 古い順（右が新しい）
  const maps = visits.map(drugsOf);
  const rows = [];
  for (const m of maps) for (const d of m.values()) if (!rows.some((r) => r.code === d.code)) rows.push(d);
  // 来局ごとのセル（開始・変更・中止は1つ前の来局と比べる。表を分けても比べる相手は変わらない）
  const cellOf = (row, k) => {
    const d = maps[k].get(row.code);
    const prev = k > 0 ? maps[k - 1].get(row.code) : undefined;
    if (!d) return prev ? '<td class="stop">中止</td>' : "<td></td>";
    const cls = !prev ? "start" : prev.qty !== d.qty || prev.days !== d.days || prev.usage !== d.usage ? "change" : "on";
    return `<td class="${cls}">${qtyText(d)}<small>${d.days}日分</small></td>`;
  };
  const table = (ks) => {
    const shown = rows.filter((row) => ks.some((k) => maps[k].has(row.code) || (k > 0 && maps[k - 1].has(row.code))));
    return `<table class="matrix"><thead><tr><th>薬</th>${ks.map((k) => `<th class="${k === visits.length - 1 ? "latest" : ""}">${formatDate(visits[k].dispensedOn)}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((row) => {
        const latestUsage = [...maps].reverse().find((m) => m.has(row.code)).get(row.code).usage;
        return `<tr data-code="${row.code}"><th>${escapeHtml(row.name)}<span class="usage">${escapeHtml(latestUsage)}</span></th>${ks.map((k) => cellOf(row, k)).join("")}</tr>`;
      }).join("")}</tbody></table>`;
  };
  const all = visits.map((_, k) => k);
  let tables;
  if (matrixFold === 1) {
    // 薬の名前の列（約240px）を除いた幅に入る来局の数ずつに分け、新しい来局の表を上にする
    const per = Math.max(1, Math.floor((matrixView.clientWidth - 240) / 92));
    tables = [];
    for (let end = all.length; end > 0; end -= per) tables.push(table(all.slice(Math.max(0, end - per), end)));
  } else {
    tables = [table(all)];
  }
  matrixView.innerHTML = `
    <div class="legend"><span class="l-start">開始・再開</span><span class="l-change">1日量・用法・日数の変更</span><span class="l-stop">中止</span><span class="l-on">前回と同じ</span></div>
    ${tables.map((h) => `<div class="matrix-part">${h}</div>`).join("")}`;
  if (matrixFold === 0) matrixView.scrollLeft = matrixView.scrollWidth; // 入りきらないときは新しい側を見せる
}

const matrixButtons = [...document.querySelectorAll("#matrix-shape [data-fold]")];
function applyMatrixFold(fold) {
  matrixFold = fold;
  matrixView.classList.toggle("folded", fold === 1);
  for (const b of matrixButtons) b.setAttribute("aria-checked", String(Number(b.dataset.fold) === fold));
  renderMatrix();
}
for (const b of matrixButtons) b.addEventListener("click", () => layout.setOption("matrixFold", Number(b.dataset.fold)));
// 折り返しのときは、箱の幅が変わったら分け方を作り直す
let matrixWidth = 0;
new ResizeObserver(() => {
  if (matrixFold === 1 && matrixView.clientWidth !== matrixWidth) {
    matrixWidth = matrixView.clientWidth;
    renderMatrix();
  }
}).observe(matrixView);

// ---------- 経過の並べ方 ----------
// 0＝折り返し（横に並べ、入りきらなければ次の行へ）。1〜3＝その段数の帯（左が新しい、右が古い。入りきらない古い来局は帯を横に送る）
const shapeButtons = [...document.querySelectorAll("#history-shape [data-rows]")];
function applyShape(rows) {
  timeline.classList.toggle("band", rows > 0);
  timeline.style.gridTemplateColumns = rows > 0 ? `repeat(${Math.max(1, Math.ceil(prescriptions.length / rows))}, 340px)` : "";
  for (const b of shapeButtons) b.setAttribute("aria-checked", String(Number(b.dataset.rows) === rows));
}
for (const b of shapeButtons) b.addEventListener("click", () => layout.setOption("historyRows", Number(b.dataset.rows)));

// ---------- 患者メモの追加 ----------

const noteDialog = document.querySelector("#note-dialog");
const noteForm = document.querySelector("#note-form");
const noteBody = noteForm.elements.body;
document.querySelector("#note-categories").innerHTML = NOTE_CATEGORIES.map((c) =>
  `<label><input type="radio" name="category" value="${c.key}">${escapeHtml(c.label)}</label>`).join("");

// category を渡すと、その分類を選んだ状態で開く（箱の見出しの「＋」から）
function openNoteDialog(category = null) {
  noteForm.reset();
  clearFormErrors(noteForm);
  updateCounter();
  noteDialog.showModal();
  if (category === null) {
    noteForm.querySelector('input[name="category"]').focus();
  } else {
    noteForm.querySelector(`input[name="category"][value="${category}"]`).checked = true;
    noteBody.focus();
  }
}
for (const b of document.querySelectorAll("[data-note]")) b.addEventListener("click", () => openNoteDialog(b.dataset.note));

function updateCounter() {
  noteForm.querySelector('[data-counter="note-body"]').textContent = `${noteBody.value.length} / ${NOTE_MAX}文字`;
}
noteBody.addEventListener("input", updateCounter);

noteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await submit(noteForm, async () => {
    const note = await api(`/api/patients/${patient.id}/notes`, {
      method: "POST",
      body: { category: noteForm.elements.category.value, body: noteBody.value },
    });
    notes.unshift(note);
    noteDialog.close();
    renderBand();
    renderSummary(note.id);
    toast(`${NOTE_LABEL[note.category]}のメモを追加しました`);
  });
});

// ---------- 指導記録の記載 ----------

const recordDialog = document.querySelector("#record-dialog");
const recordForm = document.querySelector("#record-form");
let recordIndex = -1;
document.querySelector("#soap-fields").innerHTML = SOAP.map((s) => `
  <div class="soap-field">
    <span class="letter">${s.letter}</span>
    <label for="soap-${s.key}">${s.label}</label>
    <textarea class="input textarea" id="soap-${s.key}" name="${s.key}" rows="3" maxlength="1000"></textarea>
  </div>`).join("");
const radios = (name, options) => Object.entries(options).map(([value, label]) =>
  `<label><input type="radio" name="${name}" value="${value}">${label}</label>`).join("");
document.querySelector("#leftover").innerHTML = radios("leftover", LEFTOVER);
document.querySelector("#notebook").innerHTML = radios("notebook", NOTEBOOK);

// 書く前に、その来局で何が変わったかと、それより前の留意点（P）を見せる。
// 右側には、会話の録音・指導内容の提案・つながる薬局のメッセージを出す
const assist = { conversation: null, drafted: false, extracted: [], suggestions: [] };
let templates = null; // 最初に開いたときに読む

async function openRecordDialog(i = selectedIndex) {
  if (i < 0) {
    toast("来局がまだありません。先に処方を入力してください", "error");
    return;
  }
  recordIndex = i;
  select(i);
  const rx = prescriptions[i];
  recordForm.reset();
  recordForm.elements.leftover.value = "unchecked";
  recordForm.elements.notebook.value = "unchecked";
  clearFormErrors(recordForm);
  document.querySelector("#record-dialog-title").textContent = `指導記録を記載　${formatDate(rx.dispensedOn)}の来局`;
  const before = latestRecordFrom(i + 1);
  document.querySelector("#record-context").innerHTML = `
    <div><span class="label">処方の変化</span>${changesHtml(changesOf(i))}</div>
    <div><span class="label">それまでの留意点（P）</span>${before && before.record.plan
      ? `${escapeHtml(before.record.plan)}（${formatDate(before.rx.dispensedOn)}）` : "なし"}</div>`;

  assist.conversation = rx.conversations[0] ?? null; // その来局の会話がもうあれば使う
  assist.drafted = false;
  assist.extracted = assist.conversation ? extractNotes(assist.conversation.transcript) : [];
  assist.suggestions = suggestGuidance({
    rx, prevRx: prescriptions[i + 1] ?? null, patient, notes,
    latest: latestByItem(measurements, rx.dispensedOn),
    lastRecord: before ? { on: formatDate(before.rx.dispensedOn), plan: before.record.plan, leftover: before.record.leftover } : null,
  });
  document.querySelector("#drafted-tag").hidden = true;
  renderConversation();
  renderSuggestions();
  renderLineMessages(i);
  if (templates === null) templates = await api("/api/templates");
  renderTemplates();
  recordDialog.showModal();
  recordForm.elements.subjective.focus();
}

// ---------- 会話の録音と文字起こし ----------

const recToggle = document.querySelector("#rec-toggle");
const recTime = document.querySelector("#rec-time");
const recFile = document.querySelector("#rec-file");
let recorder = null; // 録音中の { media, startedAt, timer }

function renderConversation() {
  const c = assist.conversation;
  recToggle.innerHTML = `${icon("mic", 14)}${recorder ? "録音を止めて文字にする" : c ? "録音し直す" : "録音を始める"}`;
  recToggle.classList.toggle("recording", recorder !== null);
  recTime.hidden = recorder === null;
  const box = document.querySelector("#transcript");
  box.hidden = c === null;
  box.innerHTML = c ? `<div class="meta">${c.durationSec}秒・${c.source === "file" ? escapeHtml(c.fileName) : "録音"}</div>${transcriptHtml(c.transcript)}` : "";
  const ex = document.querySelector("#extracted");
  ex.hidden = assist.extracted.length === 0;
  ex.innerHTML = `<h4>会話から拾った患者メモの候補<span class="sub">チェックしたものを、保存のときにメモへ追加</span></h4>${assist.extracted.map((n, k) =>
    `<label class="check-row"><input type="checkbox" data-extract="${k}"><span class="tag">${NOTE_LABEL[n.category]}</span>${escapeHtml(n.body)}</label>`).join("")}`;
}

recToggle.addEventListener("click", async () => {
  if (recorder) {
    const sec = Math.max(1, Math.round((Date.now() - recorder.startedAt) / 1000));
    recorder.media.stop();
    for (const t of recorder.media.stream.getTracks()) t.stop();
    clearInterval(recorder.timer);
    recorder = null;
    await transcribe({ source: "recording", durationSec: sec });
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // マイクの使用を許可しなかった・マイクが無い：利用者が直せることなので理由を出す
    if (err.name !== "NotAllowedError" && err.name !== "NotFoundError") throw err;
    toast(err.name === "NotAllowedError" ? "マイクの使用が許可されていません。ブラウザの設定で許可してください" : "マイクが見つかりません", "error");
    return;
  }
  const media = new MediaRecorder(stream);
  media.start(); // 音声のデータは使わない（文字起こしは固定の文。音声は保存しない）
  recorder = { media, startedAt: Date.now(), timer: setInterval(() => {
    const s = Math.round((Date.now() - recorder.startedAt) / 1000);
    recTime.textContent = `● ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 500) };
  recTime.textContent = "● 0:00";
  renderConversation();
});

document.querySelector("#rec-file-btn").addEventListener("click", () => recFile.click());
recFile.addEventListener("change", async () => {
  const file = recFile.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  const seconds = await new Promise((resolve) => {
    audio.addEventListener("loadedmetadata", () => resolve(audio.duration), { once: true });
    audio.addEventListener("error", () => resolve(NaN), { once: true });
    audio.src = url;
  });
  URL.revokeObjectURL(url);
  recFile.value = "";
  if (!Number.isFinite(seconds) || seconds <= 0) {
    toast("録音の長さを読めないファイルです", "error");
    return;
  }
  await transcribe({ source: "file", fileName: file.name, durationSec: Math.max(1, Math.round(seconds)) });
});

async function transcribe(body) {
  const rx = prescriptions[recordIndex];
  recToggle.disabled = true;
  try {
    const c = await api(`/api/prescriptions/${rx.id}/conversations`, { method: "POST", body });
    rx.conversations.unshift(c);
    assist.conversation = c;
    assist.extracted = extractNotes(c.transcript);
    renderConversation();
    renderTimeline();
    select(recordIndex, false);
    toast("会話を文字にしました。「下書きを作る」で S・O・A・P に組み立てられます");
  } finally {
    recToggle.disabled = false;
  }
}

// ---------- 下書き・提案・テンプレート ----------

function makeDraft() {
  const rx = prescriptions[recordIndex];
  const latest = latestByItem(measurements, rx.dispensedOn);
  const draft = buildDraft({
    transcript: assist.conversation?.transcript ?? "",
    changes: changesOf(recordIndex).filter((c) => c.kind !== "same" && c.kind !== "first")
      .map((c) => `${CHANGE_LABEL[c.kind]} ${c.name}${c.text ? ` ${c.text}` : ""}`),
    labs: Object.entries(latest).map(([key, v]) => ({ label: LAB[key].label, text: labText(key, v.valueMilli), measuredOn: v.measuredOn })),
    suggestions: assist.suggestions,
    on: rx.dispensedOn,
  });
  for (const { key } of SOAP) recordForm.elements[key].value = draft[key];
  if (draft.leftover === "some") recordForm.elements.leftover.value = "some";
  assist.drafted = true;
  document.querySelector("#drafted-tag").hidden = false;
  recordForm.elements.subjective.focus();
  toast(assist.conversation ? "下書きを作りました。内容を確かめて直してください" : "会話が無いので、処方・検査値・提案から下書きを作りました");
}
document.querySelector("#make-draft").addEventListener("click", makeDraft);

function renderSuggestions() {
  const KIND = { drug: "薬", patient: "患者", history: "経過" };
  document.querySelector("#suggestions").innerHTML = assist.suggestions.length
    ? assist.suggestions.map((s, k) => `<li class="sg-${s.kind}">
        <div class="sg-head"><span class="tag">${KIND[s.kind]}</span><b>${escapeHtml(s.title)}</b>
          <button type="button" class="btn btn-ghost btn-small" data-suggest="${k}">P に写す</button></div>
        <div class="sg-plan">${escapeHtml(s.plan)}</div><div class="sg-reason">根拠：${escapeHtml(s.reason)}</div></li>`).join("")
    : '<li class="none">この処方・患者の情報からの提案はありません</li>';
}

// P の末尾に1文足す（同じ文がもうあれば足さない）
function appendTo(key, text) {
  const el = recordForm.elements[key];
  if (el.value.includes(text)) return;
  el.value = el.value.trim() === "" ? text : `${el.value.trimEnd()}\n${text}`;
  el.classList.add("flash");
  el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
}

document.querySelector("#suggestions").addEventListener("click", (e) => {
  const b = e.target.closest("[data-suggest]");
  if (b) appendTo("plan", assist.suggestions[Number(b.dataset.suggest)].plan);
});

function renderTemplates() {
  const sel = document.querySelector("#template-select");
  sel.innerHTML = templates.length
    ? templates.map((t) => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join("")
    : "<option value=\"\">（テンプレートなし）</option>";
}

document.querySelector("#apply-template").addEventListener("click", () => {
  const t = templates.find((x) => String(x.id) === document.querySelector("#template-select").value);
  if (!t) return;
  for (const { key } of SOAP) if (t[key]) appendTo(key, t[key]);
});

document.querySelector("#save-template").addEventListener("click", async () => {
  const title = window.prompt("テンプレートの名前（40文字まで）");
  if (title === null) return;
  const body = { title, ...Object.fromEntries(SOAP.map(({ key }) => [key, recordForm.elements[key].value])) };
  try {
    const t = await api("/api/templates", { method: "POST", body });
    templates.push(t);
    templates.sort((a, b) => a.title.localeCompare(b.title, "ja"));
    renderTemplates();
    document.querySelector("#template-select").value = String(t.id);
    toast(`テンプレート「${t.title}」を保存しました`);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 422) throw err;
    toast(err.details[0].message, "error");
  }
});

// 前回の来局より後に届いた、患者からのメッセージ
function renderLineMessages(i) {
  const from = prescriptions[i + 1]?.dispensedOn ?? null;
  const to = prescriptions[i - 1]?.dispensedOn ?? null;
  const list = messages.filter((m) => m.direction === "in" && (from === null || m.sentAt.slice(0, 10) > from)
    && (to === null || m.sentAt.slice(0, 10) <= to));
  document.querySelector("#line-block").hidden = list.length === 0;
  document.querySelector("#line-list").innerHTML = list.map((m) => `<li><span class="meta">${formatDateTime(m.sentAt)}</span>${escapeHtml(m.body)}
    <button type="button" class="btn btn-ghost btn-small" data-line="${m.id}">S に写す</button></li>`).join("");
}

document.querySelector("#line-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-line]");
  if (!b) return;
  const m = messages.find((x) => String(x.id) === b.dataset.line);
  appendTo("subjective", `（つながる薬局 ${formatDate(m.sentAt.slice(0, 10))}）${m.body}`);
});

recordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (recorder) {
    toast("録音中です。先に録音を止めてください", "error");
    return;
  }
  const i = recordIndex;
  const rx = prescriptions[i];
  await submit(recordForm, async () => {
    const body = Object.fromEntries(SOAP.map(({ key }) => [key, recordForm.elements[key].value]));
    body.leftover = recordForm.elements.leftover.value;
    body.notebook = recordForm.elements.notebook.value;
    body.conversationId = assist.conversation?.id ?? null;
    body.drafted = assist.drafted;
    const record = await api(`/api/prescriptions/${rx.id}/records`, { method: "POST", body });
    rx.records.unshift(record);
    // 会話から拾ったメモのうち、チェックしたものを患者メモに足す
    const picked = [...recordForm.querySelectorAll("[data-extract]:checked")].map((c) => assist.extracted[Number(c.dataset.extract)]);
    let added = [];
    if (picked.length) {
      added = await api(`/api/patients/${patient.id}/notes-batch`, { method: "POST", body: { notes: picked.map((n) => ({ ...n, source: "conversation" })) } });
      notes.unshift(...added.reverse());
      renderBand();
    }
    recordDialog.close();
    renderTimeline();
    renderSummary();
    select(i);
    timeline.querySelector(`.record[data-id="${record.id}"]`).classList.add("new");
    timeline.focus({ preventScroll: true });
    toast(`指導記録を保存しました${added.length ? `（患者メモ ${added.length}件も追加）` : ""}`);
  });
});

recordDialog.addEventListener("close", () => {
  if (!recorder) return; // 録音中に閉じたら録音を捨てる
  recorder.media.stop();
  for (const t of recorder.media.stream.getTracks()) t.stop();
  clearInterval(recorder.timer);
  recorder = null;
});

// ---------- 検査値・体重の入力 ----------

const labDialog = document.querySelector("#lab-dialog");
const labForm = document.querySelector("#lab-form");
const labPhoto = document.querySelector("#lab-photo");
let labSource = "manual";
document.querySelector("#lab-photo-btn").insertAdjacentHTML("afterbegin", icon("camera", 16));
document.querySelector("#lab-grid").innerHTML = LAB_ITEMS.map((item, k) => `
  <div class="lab-cell">
    <label for="lab-${item.key}">${escapeHtml(item.label)}</label>
    <span class="lab-input"><input class="input num" id="lab-${item.key}" name="values.${k}.value" inputmode="decimal" autocomplete="off"><span class="unit">${escapeHtml(item.unit)}</span></span>
    <span class="error-text" data-error="values.${k}.value"></span>
  </div>`).join("");

function openLabDialog() {
  labForm.reset();
  clearFormErrors(labForm);
  labSource = "manual";
  document.querySelector("#lab-photo-tag").hidden = true;
  labForm.elements.measuredOn.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  for (const item of LAB_ITEMS) {
    const last = measurements.find((m) => m.item === item.key);
    document.querySelector(`#lab-${item.key}`).placeholder = last ? `前回 ${formatLabValue(item.key, last.valueMilli)}` : "";
  }
  labDialog.showModal();
  labForm.elements.measuredOn.focus();
}

document.querySelector("#lab-photo-btn").addEventListener("click", () => labPhoto.click());
labPhoto.addEventListener("change", async () => {
  const file = labPhoto.files[0];
  if (!file) return;
  // 写真そのものは送らない（読み取りは固定の結果を返すため）。ファイル名と大きさだけを送る
  const { values } = await api("/api/lab-sheet", { method: "POST", body: { fileName: file.name, size: file.size } });
  labPhoto.value = "";
  for (const v of values) {
    const el = document.querySelector(`#lab-${v.item}`);
    el.value = v.value;
    el.classList.add("flash");
  }
  labSource = "photo";
  document.querySelector("#lab-photo-tag").hidden = false;
  toast(`用紙から ${values.length}項目を読み取りました。値と検査日を確かめてから保存してください`);
});

labForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await submit(labForm, async () => {
    const body = {
      measuredOn: labForm.elements.measuredOn.value,
      source: labSource,
      values: LAB_ITEMS.map((item) => ({ item: item.key, value: document.querySelector(`#lab-${item.key}`).value })),
    };
    const list = await api(`/api/patients/${patient.id}/measurements`, { method: "POST", body });
    measurements.splice(0, measurements.length, ...list);
    labDialog.close();
    renderSummary();
    document.querySelector("#labs").classList.add("flash");
    toast("検査値を保存しました");
  });
});

// ---------- ダイアログ共通 ----------

async function submit(form, action) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  clearFormErrors(form);
  try {
    await action();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 422) throw err;
    for (const d of err.details) form.querySelector(`[data-error="${d.path}"]`).textContent = d.message;
    form.querySelector(`[name="${err.details[0].path}"]`).focus();
  } finally {
    button.disabled = false;
  }
}

function clearFormErrors(form) {
  for (const el of form.querySelectorAll("[data-error]")) el.textContent = "";
}

for (const form of [noteForm, recordForm, labForm]) {
  form.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.querySelector("[data-close]").addEventListener("click", () => form.closest("dialog").close());
}
document.querySelector("#add-note").addEventListener("click", () => openNoteDialog());
document.querySelector("#add-lab").addEventListener("click", openLabDialog);

// ---------- メモ帳 ----------
const memoPad = setupMemoPad({ patientId: patient.id, memo, onSaved: renderMemo });
function renderMemo(m) {
  document.querySelector("#memo").innerHTML = memoText(m);
  document.querySelector("#memo-meta").textContent = memoMeta(m);
}
document.querySelector("#edit-memo").addEventListener("click", () => memoPad.open());
document.querySelector("#memo").addEventListener("click", () => memoPad.open());
renderMemo(memo);

// ---------- ショートカット ----------

// ---------- 操作の帯 ----------
// 別の作業は薬歴の上に重なる窓で開く（overlay.js）。Esc・×・ブラウザの「戻る」で閉じ、薬歴の同じ場所に戻る
const selected = () => prescriptions[selectedIndex];
function openDo(i = selectedIndex) {
  if (i >= 0) openOverlay(`/rx?patient=${patient.id}&from=${prescriptions[i].id}`);
}
const openNewRx = () => openOverlay(`/rx?patient=${patient.id}`);
const openTracing = () => openOverlay(tracingHref(selected()));
document.querySelector("#new-rx").addEventListener("click", openNewRx);
document.querySelector("#do-rx").addEventListener("click", () => openDo());
document.querySelector("#write-record").addEventListener("click", () => openRecordDialog());
document.querySelector("#open-receipt").addEventListener("click", () => openOverlay(`/receipt?id=${selected().id}`));
document.querySelector("#open-handbook").addEventListener("click", () => openOverlay(`/handbook?id=${selected().id}`));
document.querySelector("#open-inspect").addEventListener("click", () => openOverlay(`/inspect?id=${selected().id}`));
document.querySelector("#to-tracing").addEventListener("click", openTracing);
document.querySelector("#to-logs").addEventListener("click", () => openOverlay(`/logs?patient=${patient.id}`));
for (const b of visitButtons) b.disabled = prescriptions.length === 0;

// 指導記録を書いている間の Alt+G（下書き）
recordForm.addEventListener("keydown", (e) => {
  if (e.altKey && e.code === "KeyG") {
    e.preventDefault();
    makeDraft();
  }
});

document.addEventListener("keydown", (e) => {
  if (!e.altKey || tourActive() || document.querySelector("dialog[open]")) return;
  const actions = {
    KeyN: openNewRx,
    KeyD: () => openDo(),
    KeyK: () => openRecordDialog(),
    KeyM: () => openNoteDialog(),
    KeyL: openLabDialog,
    KeyE: () => memoPad.open(),
    KeyT: openTracing,
  };
  if (actions[e.code]) {
    e.preventDefault();
    actions[e.code]();
  }
});

// ---------- 開始 ----------

renderBand();
renderSummary();
renderTimeline();
renderMatrix();
if (prescriptions.length > 0) {
  const savedIndex = prescriptions.findIndex((rx) => rx.id === savedId);
  select(savedIndex >= 0 ? savedIndex : 0, savedIndex >= 0); // 開いたときは上（注意点など）から見せる。保存した直後だけ、その来局まで送る
  if (savedIndex >= 0) timeline.querySelector(`.visit-card[data-index="${savedIndex}"]`).classList.add("saved");
  timeline.focus({ preventScroll: true });
}
await layout.load();

setTour("patient", [
  {
    title: "薬歴：この患者のことを1画面で",
    body: `<p>来局した患者を開くと、最初にこの画面が出ます。箱に分けて並べています。</p>
      <div class="tour-map">
        <div><b>いちばん上</b>戻る（患者一覧へ）・画面の名前・患者の氏名</div>
        <div><b>青い帯</b>右端に新規処方。左に閲覧記録と配置を変える</div>
        <div><b>箱</b>患者・注意点・次に確認すること・今の処方・メモ帳・検査値、処方の推移、経過。書き足すときは箱の見出しの「＋」</div>
        <div><b>経過の帯</b>選んだ来局への操作（Do・指導記録・領収証など）</div>
      </div>`,
  },
  {
    target: "#band",
    title: "患者",
    body: "<p>氏名・カナ・生年月日・性別・負担割合・患者番号・最終来局日です。</p>",
  },
  {
    target: "#cautions",
    title: "注意点",
    body: `<p>アレルギー歴・副作用歴・疾患・併用薬を1つの表にまとめています。<strong>赤い行</strong>はアレルギー歴と副作用歴です。</p>
      <p><kbd>Alt</kbd>+<kbd>M</kbd> でメモを追加します。分類は、厚労省の通知が薬歴に記載を求める項目に合わせています。</p>`,
  },
  {
    target: "#next",
    title: "次に確認すること",
    body: "<p>前回の指導記録で「次に確かめる」と決めたこと（P）と、薬剤師どうしの申し送りです。</p>",
  },
  {
    target: "#memo",
    title: "メモ帳",
    body: "<p>決まった分類に入らないことを自由に書く場所です。家族構成、気がかりなこと、スタッフ間の伝言など、薬局の使い方に合わせて書きます。<kbd>Alt</kbd>+<kbd>E</kbd> か、箱を押すと書けます。処方入力の画面からも同じメモ帳を開けます。</p>",
  },
  {
    target: "#labs",
    title: "検査値・体重",
    body: `<p>項目ごとに、いちばん新しい値と検査日です。前回より上がった・下がったは矢印で分かります。<kbd>Alt</kbd>+<kbd>L</kbd> で入力します。</p>`,
  },
  {
    target: ".visit-card",
    optional: true,
    title: "経過：来局ごとのカード",
    body: `<p>新しい来局から順に左から並べます。見出しの<strong>並べ方</strong>で「折り返し」（入りきらなければ次の行へ。下へ伸びる）か「1段・2段の帯」（左が新しい、右が古い）を選べます。開かなくても中身が読めます。</p>
      <ul>
        <li><b>処方の変化</b>：前回と比べて <span class="change add"><b>＋追加</b></span> <span class="change stop"><b>−中止</b></span> <span class="change mod"><b>変更</b></span></li>
        <li><b>指導記録</b>：S 会話・訴え、O 服薬状況や検査値、A 薬剤師の所見、<strong>P 次回の留意点</strong></li>
      </ul>
      <p><kbd>↑</kbd><kbd>↓</kbd>（帯では <kbd>←</kbd><kbd>→</kbd> も）で来局を選ぶと、その来局が大きくなり、処方の中身が出ます。経過の見出しの下の帯の操作は、この来局に対して働きます。見出しの<strong>薬剤料</strong>は、その日の薬の値段を点数にしたもの（1点＝10円）です。</p>`,
  },
  {
    target: () => document.querySelector(".no-record") ?? document.querySelector(".vc-records"),
    optional: true,
    title: "指導記録を書く",
    body: `<p>記録が無い来局には<strong>「指導記録 未記載」</strong>の枠が出ます。</p>
      <p><kbd>Alt</kbd>+<kbd>K</kbd> で、選んでいる来局の記録を書けます。書く画面には、その来局の処方の変化と、それまでの留意点（P）が出ます。</p>
      <p>書く画面の右側では、次のことができます。</p>
      <ul>
        <li><b>会話の録音</b>：服薬指導の会話を録音して文字にします（このアプリでは決まった文を返します）。会話から既往歴・併用薬などの候補を拾い、選ぶと患者メモに足せます</li>
        <li><b>指導内容の提案</b>：処方の薬・アレルギー歴・検査値・前回の留意点から、触れることを根拠つきで出します。「P に写す」で写します</li>
        <li><b>つながる薬局</b>：前回の来局より後に患者から届いたメッセージを、S に写せます</li>
      </ul>
      <p><strong>「下書きを作る」</strong>（<kbd>Alt</kbd>+<kbd>G</kbd>）で、会話・処方の変化・検査値・提案から S・O・A・P をまとめて組み立てます。テンプレートも写せます。</p>`,
  },
  {
    target: "[data-box=matrix]",
    title: "処方の推移",
    body: `<p>薬 × 来局日の表です。見出しの<strong>並べ方</strong>で、1つの表を横に送って見るか、入りきらない古い来局を下の表へ回すかを選べます。どの薬が<strong>いつ始まり、いつ変わり、いつ止まったか</strong>が一目で分かります。</p>`,
  },
  {
    target: "#layout-edit",
    title: "配置を変える",
    body: `<p>押すと箱の見出しを引っぱって動かせます。ほかの箱の上へ持っていくと、そこに割り込み、後ろの箱は右へ、入らなければ次の段へ押し出されます。右下の角を引っぱると幅と高さ（段）が変わります。「完了」で保存し、次からもその配置で開きます（利用者ごと）。</p>
      <p>箱の高さは中身に合わせて伸びます。幅を広げると、長い注意点や処方が少ない行数で収まります。</p>`,
  },
  {
    target: "#toolbar",
    title: "青い帯",
    body: `<p>右端の<strong>新規処方</strong> <kbd>Alt</kbd>+<kbd>N</kbd> で、今日の処方を入力します。</p>
      <p>左の<b>閲覧記録</b>は、この患者の情報を誰がいつ開いたかの記録です。<b>配置を変える</b>で箱の並びを変えられます。</p>
      <p>処方入力や領収証などは、この画面の上に<strong>重なる窓</strong>で開きます。<kbd>Esc</kbd>・右上の ×・ブラウザの「戻る」のどれでも閉じて、この画面の同じ場所に戻ります。</p>`,
  },
  {
    target: "#visit-bar",
    title: "選んだ来局への操作",
    body: `<p>経過で選んでいる来局に対して働きます。</p>
      <ul>
        <li><b>この処方でDo</b> <kbd>Alt</kbd>+<kbd>D</kbd>：その処方を写して新しい処方を入力する（薬価は今日の日付で引き直す）</li>
        <li><b>指導記録を書く</b> <kbd>Alt</kbd>+<kbd>K</kbd>・<b>領収証・明細書</b>・<b>お薬手帳</b>・<b>調剤監査</b>・<b>トレーシングレポート</b> <kbd>Alt</kbd>+<kbd>T</kbd></li>
      </ul>`,
  },


]);
autoStartTour();
