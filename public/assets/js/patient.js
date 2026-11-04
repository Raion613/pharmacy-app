// 薬歴：再来局した患者を開いたときに、この人について知っておくべきことを1画面で見渡す。
//   左：この患者の要点（前回の留意点・今の処方とその開始日・申し送り・体質・疾患・併用薬・生活）
//   中央「経過」：全来局を新しい順に。処方の変化・処方・指導記録（会話・所見・留意点）を開かずに読める
//   中央「処方の推移」：薬 × 来局日の表。いつ始まり・変わり・止まったか
import {
  renderShell, setCrumbs, api, ApiError, escapeHtml, formatDate, formatDateTime, renderPatientBand, priceText, pointsText,
  unitText, toast,
} from "./app.js";
import { dailyCost, formatYen, formatSen, formatQuantity } from "./yakuzairyo.js";
import { NOTE_CATEGORIES, NOTE_LABEL, SOAP, LEFTOVER, NOTEBOOK, NOTE_MAX } from "./record-kinds.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";
import { icon } from "./icons.js";

const SECTION = { tech: "調剤技術料", mgmt: "薬学管理料", other: "その他" };
const HANDBOOK = { paper: "提示あり（紙）", electronic: "提示あり（電子版）", none: "提示なし" };
const CHANGE_REASON = { general: "一般名処方の銘柄を選んだ", generic: "後発品に変更した", inquiry: "疑義照会で変わった" };
const DAYS_CHANGE = { inquiry: "疑義照会で減らした", instruction: "処方箋の指示で減らした" };
const INQUIRY_KIND = { leftover: "残薬調整", adverse: "重複投薬・相互作用など" };

const params = new URLSearchParams(location.search);
const patientId = params.get("id");
const savedId = params.get("saved");

renderShell({ page: "patients", title: "薬歴", crumbs: [{ label: "患者一覧", href: "/patients" }, { label: "薬歴" }] });

// prescriptions は新しい順（調剤日の降順）でサーバーから来る
const { patient, notes, prescriptions } = await api(`/api/patients/${patientId}`);

setCrumbs([{ label: "患者一覧", href: "/patients" }, { label: `${patient.name}（${patient.patientNo}）` }, { label: "薬歴" }]);
document.querySelector("#new-rx").href = `/rx?patient=${patient.id}`;
document.querySelector("#to-logs").href = `/logs?patient=${patient.id}`;

const band = document.querySelector("#band");
const summaryBody = document.querySelector("#summary-body");
const timeline = document.querySelector("#timeline");
const matrixView = document.querySelector("#matrix-view");
const doButton = document.querySelector("#do-rx");
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

// ---------- 左：この患者の要点 ----------

function renderSummary(newNoteId = null) {
  const parts = [];

  const last = latestRecordFrom(0);
  if (last && last.record.plan) {
    parts.push(`<section class="last-plan" id="last-plan">
      <h3>前回の留意点（P）<span class="sub">${formatDate(last.rx.dispensedOn)} ${escapeHtml(last.record.createdBy)}</span></h3>
      <p>${escapeHtml(last.record.plan)}</p></section>`);
  }

  // 今の処方：最終来局の薬と、いつから続いているか（同じ薬が途切れずに出ている最初の来局）
  if (prescriptions.length) {
    const latest = prescriptions[0];
    const items = [...drugsOf(latest).values()].map((d) => {
      let i = 0;
      while (i + 1 < prescriptions.length && drugsOf(prescriptions[i + 1]).has(d.code)) i++;
      const recent = i === 0 && prescriptions.length > 1;
      return `<li><span class="name">${escapeHtml(d.name)}</span><span class="dose">${qtyText(d)}</span>
        <span class="since ${recent ? "recent" : ""}">${escapeHtml(d.usage)} ／ ${recent ? "最終来局で追加" : `${formatDate(prescriptions[i].dispensedOn)}から（${i + 1}回）`}</span></li>`;
    }).join("");
    parts.push(`<section class="current-meds" id="current-meds"><h3>今の処方<span class="sub">最終来局 ${formatDate(latest.dispensedOn)}</span></h3><ul>${items}</ul></section>`);
  }

  // メモは、申し送り → 体質 → 疾患 → 併用薬 → 生活 → 後発品 の順（来局時にまず読みたい順）
  const order = ["handover", ...NOTE_CATEGORIES.map((c) => c.key).filter((k) => k !== "handover")];
  for (const key of order) {
    const c = NOTE_CATEGORIES.find((x) => x.key === key);
    const items = notes.filter((n) => n.category === key);
    const body = items.length
      ? `<ul>${items.map((n) => `<li class="${n.id === newNoteId ? "new" : ""}">${escapeHtml(n.body)}<span class="meta">${formatDate(n.createdAt.slice(0, 10))} ${escapeHtml(n.createdBy)}</span></li>`).join("")}</ul>`
      : '<div class="none">記録なし</div>';
    const cls = items.length && c.alert ? "alert" : items.length && key === "handover" ? "handover" : "";
    parts.push(`<section class="note-group ${cls}" data-category="${key}">
      <h3>${escapeHtml(c.label)}${items.length > 1 ? `<span class="count">${items.length}件</span>` : ""}</h3>${body}</section>`);
  }
  summaryBody.innerHTML = parts.join("");
  if (newNoteId !== null) summaryBody.querySelector("li.new").scrollIntoView({ block: "nearest" });
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
    card.querySelector("[data-action=do]").addEventListener("click", () => openDo(i));
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
  const records = rx.records.length
    ? rx.records.map(recordHtml).join("")
    : `<div class="no-record">${icon("alert", 16)}指導記録 未記載<button type="button" class="btn btn-small btn-primary" data-action="record">記載する</button></div>`;
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
      <span class="spacer"></span>
      ${rx.records.length ? '<button type="button" class="btn btn-small" data-action="record">指導記録を追記</button>' : ""}
      <a class="btn btn-small" href="/receipt?id=${rx.id}" target="_blank" rel="noopener">領収証・明細書</a>
      <a class="btn btn-small" href="/handbook?id=${rx.id}" target="_blank" rel="noopener">お薬手帳</a>
      <button type="button" class="btn btn-small" data-action="do">この処方でDo</button>
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
    <div class="record-meta"><span class="tag ${g.leftover === "some" ? "tag-warn" : ""}">${LEFTOVER[g.leftover]}</span><span class="tag">${NOTEBOOK[g.notebook]}</span>
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

function select(i, scroll = true) {
  selectedIndex = i;
  doButton.disabled = false;
  for (const card of timeline.querySelectorAll(".visit-card")) {
    const on = Number(card.dataset.index) === i;
    card.setAttribute("aria-selected", String(on));
    if (on && scroll) card.scrollIntoView({ block: "nearest" });
  }
}

timeline.addEventListener("keydown", (e) => {
  if (prescriptions.length === 0 || e.target !== timeline) return;
  const last = prescriptions.length - 1;
  const next = { ArrowDown: selectedIndex + 1, ArrowUp: selectedIndex - 1, Home: 0, End: last }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  select(Math.max(0, Math.min(last, next)));
});

// ---------- 中央：処方の推移（薬 × 来局日） ----------

function renderMatrix() {
  if (prescriptions.length === 0) {
    matrixView.innerHTML = '<p class="empty">まだ来局の記録がありません。</p>';
    return;
  }
  const visits = [...prescriptions].reverse(); // 古い順（右が最新）
  const maps = visits.map(drugsOf);
  const rows = [];
  for (const m of maps) for (const d of m.values()) if (!rows.some((r) => r.code === d.code)) rows.push(d);
  const head = visits.map((v, k) => `<th class="${k === visits.length - 1 ? "latest" : ""}">${formatDate(v.dispensedOn)}</th>`).join("");
  const body = rows.map((row) => {
    const latestUsage = [...maps].reverse().find((m) => m.has(row.code)).get(row.code).usage;
    const cells = maps.map((m, k) => {
      const d = m.get(row.code);
      const prev = k > 0 ? maps[k - 1].get(row.code) : undefined;
      if (!d) return prev ? '<td class="stop">中止</td>' : "<td></td>";
      const cls = !prev ? "start" : prev.qty !== d.qty || prev.days !== d.days || prev.usage !== d.usage ? "change" : "on";
      return `<td class="${cls}">${qtyText(d)}<small>${d.days}日分</small></td>`;
    }).join("");
    return `<tr data-code="${row.code}"><th>${escapeHtml(row.name)}<span class="usage">${escapeHtml(latestUsage)}</span></th>${cells}</tr>`;
  }).join("");
  matrixView.innerHTML = `
    <div class="legend"><span class="l-start">開始・再開</span><span class="l-change">1日量・用法・日数の変更</span><span class="l-stop">中止</span><span class="l-on">前回と同じ</span></div>
    <div><table class="matrix"><thead><tr><th>薬</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------- タブ ----------

const tabs = [document.querySelector("#tab-timeline"), document.querySelector("#tab-matrix")];
const HINTS = { "tab-timeline": "新しい来局が上", "tab-matrix": "古い順（右が最新）" };
function showTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
  document.querySelector("#history-hint").textContent = HINTS[tab.id];
  if (tab.id === "tab-matrix") matrixView.scrollLeft = matrixView.scrollWidth; // 最新の来局が見えるように
}
for (const t of tabs) {
  t.addEventListener("click", () => showTab(t));
  t.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const other = tabs[(tabs.indexOf(t) + 1) % 2];
    showTab(other);
    other.focus();
  });
}

// ---------- 患者メモの追加 ----------

const noteDialog = document.querySelector("#note-dialog");
const noteForm = document.querySelector("#note-form");
const noteBody = noteForm.elements.body;
document.querySelector("#note-categories").innerHTML = NOTE_CATEGORIES.map((c) =>
  `<label><input type="radio" name="category" value="${c.key}">${escapeHtml(c.label)}</label>`).join("");

function openNoteDialog() {
  noteForm.reset();
  clearFormErrors(noteForm);
  updateCounter();
  noteDialog.showModal();
  noteForm.querySelector('input[name="category"]').focus();
}

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

// 書く前に、その来局で何が変わったかと、それより前の留意点（P）を見せる
function openRecordDialog(i = selectedIndex) {
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
  recordDialog.showModal();
  recordForm.elements.subjective.focus();
}

recordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const i = recordIndex;
  const rx = prescriptions[i];
  await submit(recordForm, async () => {
    const body = Object.fromEntries(SOAP.map(({ key }) => [key, recordForm.elements[key].value]));
    body.leftover = recordForm.elements.leftover.value;
    body.notebook = recordForm.elements.notebook.value;
    const record = await api(`/api/prescriptions/${rx.id}/records`, { method: "POST", body });
    rx.records.unshift(record);
    recordDialog.close();
    renderTimeline();
    renderSummary();
    select(i);
    timeline.querySelector(`.record[data-id="${record.id}"]`).classList.add("new");
    timeline.focus({ preventScroll: true });
    toast("指導記録を保存しました");
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

for (const form of [noteForm, recordForm]) {
  form.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.querySelector("[data-close]").addEventListener("click", () => form.closest("dialog").close());
}
document.querySelector("#add-note").addEventListener("click", openNoteDialog);

// ---------- ショートカット ----------

function openDo(i = selectedIndex) {
  if (i >= 0) location.href = `/rx?patient=${patient.id}&from=${prescriptions[i].id}`;
}
doButton.addEventListener("click", () => openDo());

document.addEventListener("keydown", (e) => {
  if (!e.altKey || tourActive() || document.querySelector("dialog[open]")) return;
  const actions = {
    KeyN: () => { location.href = `/rx?patient=${patient.id}`; },
    KeyD: () => openDo(),
    KeyK: () => openRecordDialog(),
    KeyM: openNoteDialog,
  };
  if (actions[e.code]) {
    e.preventDefault();
    actions[e.code]();
  }
});

function renderBand() {
  renderPatientBand(band, patient, notes);
}

// ---------- 開始 ----------

renderBand();
renderSummary();
renderTimeline();
renderMatrix();
showTab(tabs[0]);
if (prescriptions.length > 0) {
  const savedIndex = prescriptions.findIndex((rx) => rx.id === savedId);
  select(savedIndex >= 0 ? savedIndex : 0);
  if (savedIndex >= 0) timeline.querySelector(`.visit-card[data-index="${savedIndex}"]`).classList.add("saved");
  timeline.focus({ preventScroll: true });
}

setTour("patient", [
  {
    title: "薬歴：この患者のことを1画面で",
    body: `<p>来局した患者を開くと、最初にこの画面が出ます。今日の対応の前に、この人について知っておくべきことを見渡せます。</p>
      <div class="tour-map">
        <div><b>上の帯</b>氏名・年齢と、アレルギー歴・副作用歴</div>
        <div><b>左</b>この患者の要点（前回の留意点・今の処方・申し送りなど）</div>
        <div><b>中央</b>来局ごとの経過（処方の変化・会話・所見）</div>
        <div><b>下</b>次の操作（処方入力・Do）</div>
      </div>`,
  },
  {
    target: "#band",
    title: "患者の帯",
    body: `<p>氏名・カナ・患者番号・年齢・性別です。</p>
      <p>右端の<strong>赤い札</strong>はアレルギー歴と副作用歴です。処方入力の画面にも同じ帯が出るので、薬を入力している間も見落としません。</p>`,
  },
  {
    target: "#summary",
    placement: "right",
    title: "この患者の要点",
    body: `<ul>
        <li><b>前回の留意点（P）</b>：前回の指導記録で「次に確かめる」と決めたこと</li>
        <li><b>今の処方</b>：最終来局の薬と、いつから続いているか</li>
        <li><b>申し送り</b>：接し方・説明の仕方など、薬剤師どうしで共有すること</li>
        <li>その下に体質・疾患・併用薬・生活状況・後発品の意向</li>
      </ul>
      <p>分類は、厚労省の通知が薬歴に記載を求める項目に合わせています。<kbd>Alt</kbd>+<kbd>M</kbd> で追加できます。</p>`,
  },
  {
    target: ".visit-card",
    optional: true,
    title: "経過：来局ごとのカード",
    body: `<p>新しい来局が上です。開かなくても中身が読めます。</p>
      <ul>
        <li><b>処方の変化</b>：前回と比べて <span class="change add"><b>＋追加</b></span> <span class="change stop"><b>−中止</b></span> <span class="change mod"><b>変更</b></span></li>
        <li><b>左</b>：その日の処方（剤ごと）</li>
        <li><b>右</b>：指導記録。S 会話・訴え、O 服薬状況や検査値、A 薬剤師の所見、<strong>P 次回の留意点</strong></li>
      </ul>
      <p>見出しの<strong>薬剤料</strong>は、その日の薬の値段を点数にしたもの（1点＝10円）です。薬の増減と薬価改定で変わります。横の<strong>合計・窓口</strong>は、調剤報酬の合計点数と、窓口で受け取った額です。算定した項目は「計算の内訳を見る」で開きます。</p>
      <p>処方箋の記載と違うものを渡したとき（一般名処方の銘柄選択・後発品への変更・残薬調整）は、処方箋の記載を小さく添えます。疑義照会もここに出ます。下の<strong>「領収証・明細書」「お薬手帳」</strong>で、渡すものを印刷できます。<kbd>↑</kbd><kbd>↓</kbd> で来局を選びます。</p>`,
  },
  {
    target: () => document.querySelector(".no-record") ?? document.querySelector(".vc-records"),
    optional: true,
    title: "指導記録を書く",
    body: `<p>記録が無い来局には<strong>「指導記録 未記載」</strong>の枠が出ます。</p>
      <p><kbd>Alt</kbd>+<kbd>K</kbd> で、選んでいる来局の記録を書けます。書く画面には、その来局の処方の変化と、それまでの留意点（P）が出ます。</p>`,
  },
  {
    target: "#tab-matrix",
    title: "処方の推移",
    body: `<p>薬 × 来局日の表に切り替えます。どの薬が<strong>いつ始まり、いつ変わり、いつ止まったか</strong>が一目で分かります。</p>`,
  },
  {
    target: ".actionbar",
    placement: "top",
    title: "次の操作",
    body: `<ul>
        <li><b>新規処方</b> <kbd>Alt</kbd>+<kbd>N</kbd>：今日の処方を入力する</li>
        <li><b>選んだ処方でDo</b> <kbd>Alt</kbd>+<kbd>D</kbd>：選んだ来局の処方を複写して入力する（薬価は今日の日付で引き直す）</li>
        <li><b>閲覧記録</b>：この患者の情報を、誰がいつ開いたか</li>
      </ul>
      <p>患者一覧へは、上のパンくずか左のアイコンで戻れます。</p>`,
  },
]);
autoStartTour();
