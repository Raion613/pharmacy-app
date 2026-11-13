// 薬歴：再来局した患者を開いたときに、この人について知っておくべきことを1画面で見渡す。
//   箱：患者・注意点（アレルギー歴・副作用歴・疾患・併用薬）・次に確認すること（前回の P・申し送り）・今の処方・生活・検査値
//   箱「処方の推移」：薬 × 来局日の表。いつ始まり・変わり・止まったか
//   箱「経過」：全来局を新しい順に。並べ方は「折り返し」か「1〜3段の帯（左が新しい）」を選べる。選んだ来局だけ処方の中身と操作を出す
//   箱の並び順と大きさは「配置を変える」で利用者ごとに変えられる（layout-grid.js）
//   指導記録を書く画面の右側：服薬指導の会話の録音と文字起こし、会話から拾った患者メモの候補、指導内容の提案、
//   つながる薬局で届いたメッセージ。左の S・O・A・P には、下書き（会話と処方から組み立てた文）とテンプレートを写せる
import {
  renderShell, api, ApiError, escapeHtml, formatDate, formatDateTime, birthText, SEX, HANDBOOK_KIND, priceText, pointsText,
  unitText, toast, toastNext, leave, today, askText,
} from "./app.js";
import { setupLayout } from "./layout-grid.js";
import { setupMemoPad, memoText, memoMeta } from "./memo-pad.js";
import { openOverlay } from "./overlay.js";
import { formatSen, formatQuantity } from "./format.js";
import { NOTE_CATEGORIES, NOTE_LABEL, SOAP, LEFTOVER, NOTE_MAX } from "./record-kinds.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";
import { icon } from "./icons.js";
import { burdenText } from "./burden-text.js";
import { openBurdenDialog } from "./burden-ui.js";
import { kohiBandText } from "./kohi-text.js";
import { openKohiDialog } from "./kohi-ui.js";
import { LAB_ITEMS, LAB, labText, latestByItem, formatLabValue } from "./lab-items.js";

// 画面を開くたびに router.js が呼ぶ（画面は中身だけを差し替えるので、画面の処理はこの関数の中に置く）
export default async function mount() {
  const SECTION = { tech: "調剤技術料", mgmt: "薬学管理料", other: "その他" };
  const HANDBOOK = { paper: "提示あり（紙）", electronic: "提示あり（電子版）", none: "提示なし" };
  const HANDBOOK_SHORT = { paper: "紙", electronic: "電子版", none: "提示なし" };
  const CHANGE_REASON = { general: "一般名処方の銘柄を選んだ", generic: "後発品に変更した", inquiry: "疑義照会で変わった" };
  const DAYS_CHANGE = { inquiry: "疑義照会で減らした", instruction: "処方箋の指示で減らした" };
  const INQUIRY_KIND = { leftover: "残薬調整", adverse: "重複投薬・相互作用など" };

  const params = new URLSearchParams(location.search);
  const patientId = params.get("id");
  const savedId = params.get("saved");
  // 受付状況の投薬待ちの札から開いたとき：その来局（rx）を選び、指導記録を保存したら受付状況のその札（reception）へ戻る
  const visitId = savedId ?? params.get("rx");
  const receptionId = params.get("reception");

  renderShell({ page: "patients", title: "薬歴", back: { label: "患者一覧", href: "/patients" } });

  // prescriptions は新しい順（調剤日の降順）でサーバーから来る
  const { patient, notes, prescriptions, measurements, messages, memo } = await api(`/api/patients/${patientId}`);

  // 窓は押した瞬間に開く。窓に出すものは裏で先に用意しておく：テンプレートは画面を開いたとき、
  // 指導内容の提案は来局を選んだとき（選び直すたび・メモを足したり直したりしたら出し直す）
  let templates = null;
  const templatesLoaded = api("/api/templates", { background: true }).then((t) => { templates = t; });
  const suggestionCache = new Map(); // 来局の番号 → { list（届くまで null）, promise }
  function suggestionsFor(i) {
    if (!suggestionCache.has(i)) {
      const rx = prescriptions[i];
      const before = latestRecordFrom(i + 1);
      const entry = { list: null };
      entry.promise = api("/api/calc/suggestions", { method: "POST", background: true, body: {
        rx, prevRx: prescriptions[i + 1] ?? null, patient, notes,
        latest: latestByItem(measurements, rx.dispensedOn),
        lastRecord: before ? { on: formatDate(before.rx.dispensedOn), plan: before.record.plan, leftover: before.record.leftover } : null,
      } }).then((list) => { entry.list = list; });
      suggestionCache.set(i, entry);
    }
    return suggestionCache.get(i);
  }

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
      options: { historyRows: 0, matrixFold: 1 }, // 処方の推移は、入りきらない来局を下の表へ回す（横に送らない）
    },
    onOptions: (options) => {
      applyShape(options.historyRows);
      applyMatrixFold(options.matrixFold);
    },
  });
  const timeline = document.querySelector("#timeline");
  const matrixView = document.querySelector("#matrix-view");
  // 操作の帯のうち、選んでいる来局に対して働くボタン
  const visitButtons = ["#to-tracing", "#to-revise", "#to-inspect", "#to-handbook", "#to-receipt"].map((s) => document.querySelector(s));
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

  // ---------- この来局の引き継ぎ（チェックリスト） ----------
  // 全ての患者に、毎回同じことを確かめる。前回の P・処方の変化がある来局だけ、その項目を出す。
  // 全部、薬剤師が押して付ける（押すたびに記録が残る）
  const handoverEl = document.querySelector("#handover");
  function handoverItems(i) {
    const rx = prescriptions[i];
    const items = [];
    if (latestRecordFrom(i + 1)?.record.plan) items.push({ key: "plan", label: "前回の P に応えた" });
    items.push({ key: "cautions", label: "アレルギー・併用薬を照らした" });
    if (changesOf(i).some((c) => ["add", "stop", "mod"].includes(c.kind))) items.push({ key: "change", label: "処方が変わった理由を聞いた" });
    items.push({ key: "soa", label: "S・O・A を書いた" });
    items.push({ key: "nextp", label: "次回の P を書いた" });
    for (const it of items) it.done = rx.checks[it.key]?.checked ?? false;
    return items;
  }
  function renderHandover() {
    if (selectedIndex < 0) {
      handoverEl.innerHTML = "";
      return;
    }
    const items = handoverItems(selectedIndex);
    const done = items.filter((it) => it.done).length;
    handoverEl.innerHTML = `<span class="hc-count ${done === items.length ? "all" : ""}">引き継ぎ ${done}/${items.length}</span>${items.map((it) => `<button type="button" class="hc ${it.done ? "done" : ""}" data-check="${it.key}" aria-pressed="${it.done}">${it.done ? "✓" : "・"} ${it.label}</button>`).join("")}`;
  }
  handoverEl.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-check]");
    if (!b) return;
    const rx = prescriptions[selectedIndex];
    const checked = b.getAttribute("aria-pressed") !== "true";
    rx.checks[b.dataset.check] = await api(`/api/prescriptions/${rx.id}/checks`, { method: "POST", body: { item: b.dataset.check, checked } });
    renderHandover();
    handoverEl.querySelector(`[data-check="${b.dataset.check}"]`).focus();
  });

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

  // 患者メモは分類ごとに1つの欄（中は何行でも）。分類の行を押す（Enter）と、その分類にチェックが入った状態で入力の窓が開く（下の「患者メモ」）
  const noteOf = (key) => notes.find((n) => n.category === key);
  const noteHtml = (key, flash) => {
    const n = noteOf(key);
    return n ? `<p class="note-text ${flash.includes(key) ? "new" : ""}">${escapeHtml(n.body)}<span class="meta">${
      formatDate(n.createdAt.slice(0, 10))} ${escapeHtml(n.createdBy)}${n.history.length ? "（修正）" : ""}</span></p>` : '<span class="none">記録なし</span>';
  };

  // 患者：氏名と、来局時に確かめる基本の事実。「負担」を押すと負担割合を変える窓
  band.addEventListener("click", async (e) => {
    if (e.target.closest("[data-kohi]")) {
      const list = await openKohiDialog(patient);
      if (list === null) return;
      patient.kohi = list;
      renderBand();
      return;
    }
    if (!e.target.closest("[data-burden]")) return;
    const updated = await openBurdenDialog(patient, today());
    if (updated === null) return;
    Object.assign(patient, updated);
    renderBand();
    toast(`負担割合を ${burdenText(patient.burdenPercent, patient.burdenReason)} で確定しました`);
  });
  band.addEventListener("change", async (e) => {
    if (e.target.id !== "handbook-kind") return;
    Object.assign(patient, await api(`/api/patients/${patient.id}/handbook`, { method: "PUT", body: { handbookKind: e.target.value } }));
    renderBand();
    toast(`お薬手帳を「${HANDBOOK_KIND[patient.handbookKind]}」にしました`);
  });
  function renderBand() {
    band.innerHTML = `
    <div class="kana">${escapeHtml(patient.kana)}</div>
    <div class="name">${escapeHtml(patient.name)}</div>
    <dl class="facts">
      <div><dt>生年月日</dt><dd>${birthText(patient.birthDate)}</dd></div>
      <div><dt>性別</dt><dd class="sex-${patient.sex}">${SEX[patient.sex]}</dd></div>
      <div><dt>負担</dt><dd><button type="button" class="burden-btn" data-burden title="負担割合を変える">${burdenText(patient.burdenPercent, patient.burdenReason)}</button></dd></div>
      <div><dt>公費</dt><dd><button type="button" class="burden-btn" data-kohi title="公費（受給者証）を見る・足す">${escapeHtml(kohiBandText(patient.kohi, today()))}</button></dd></div>
      <div><dt>手帳</dt><dd><select class="handbook-select" id="handbook-kind" title="お薬手帳の形態。処方の保存でも、出された手帳に合わせて変わります">${
        patient.handbookKind === null ? '<option value="" selected disabled>未確認</option>' : ""}${Object.entries(HANDBOOK_KIND).map(([k, label]) =>
        `<option value="${k}" ${k === patient.handbookKind ? "selected" : ""}>${label}</option>`).join("")}</select></dd></div>
      <div><dt>患者番号</dt><dd class="num">${escapeHtml(patient.patientNo)}</dd></div>
      <div><dt>最終来局</dt><dd>${patient.lastDispensedOn ? formatDate(patient.lastDispensedOn) : "—"}</dd></div>
    </dl>`;
  }

  // 注意点：アレルギー歴・副作用歴・疾患・併用薬を1つの表に。赤はアレルギー歴・副作用歴だけ
  const CAUTION_KEYS = ["allergy", "adverse", "disease", "concomitant"];
  const CAUTION_LABEL = { allergy: "アレルギー", adverse: "副作用", disease: "疾患", concomitant: "併用薬" };

  function renderCautions(flash) {
    cautionsEl.innerHTML = `<table class="cautions">${CAUTION_KEYS.map((key) => {
    const alert = noteOf(key) && NOTE_CATEGORIES.find((c) => c.key === key).alert;
    return `<tr data-category="${key}" data-note-row tabindex="0" class="${alert ? "alert" : ""}"><th>${CAUTION_LABEL[key]}</th>
      <td>${noteHtml(key, flash)}</td></tr>`;
  }).join("")}</table>`;
  }

  // 次に確認すること：前回の指導記録の P と、申し送り
  function renderNext(flash) {
    const last = latestRecordFrom(0);
    nextEl.innerHTML = (last && last.record.plan
      ? `<section class="last-plan" id="last-plan"><h3>前回の留意点（P）<span class="sub">${formatDate(last.rx.dispensedOn)} ${escapeHtml(last.record.createdBy)}</span></h3>
        <p>${escapeHtml(last.record.plan)}</p></section>`
      : "")
      + `<section data-category="handover" data-note-row tabindex="0"><h3>申し送り</h3>${noteHtml("handover", flash)}</section>`;
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
  function renderOther(flash) {
    otherEl.innerHTML = ["lifestyle", "generic"].map((key) =>
      `<section data-category="${key}" data-note-row tabindex="0"><h3>${escapeHtml(NOTE_LABEL[key])}</h3>${noteHtml(key, flash)}</section>`).join("");
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

  // flash：書き換えた分類（その欄を黄色く光らせる）
  function renderSummary(flash = []) {
    renderCautions(flash);
    renderNext(flash);
    renderMeds();
    renderOther(flash);
    renderLabs();
    document.querySelector(".note-text.new")?.scrollIntoView({ block: "nearest" });
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
      card.querySelector("[data-action=calc]").addEventListener("click", () => toggleCalc(card));
      card.querySelector("[data-compare-date]").addEventListener("change", (e) => {
        if (e.target.value) loadCompare(card, e.target.value);
      });
    }
    if (selectedIndex >= 0) select(selectedIndex, false);
  }

  // 計算の内訳を開く・閉じる。初めて開いたときに、改定をまたいだ比較も出す（比べる日付はサーバーが決める）
  function toggleCalc(card, open) {
    const calc = card.querySelector(".vc-calc");
    calc.hidden = open === undefined ? !calc.hidden : !open;
    const btn = card.querySelector("[data-action=calc]");
    btn.textContent = calc.hidden ? "計算の内訳を見る" : "計算の内訳を閉じる";
    btn.setAttribute("aria-expanded", String(!calc.hidden));
    if (!calc.hidden && !card.dataset.compared) loadCompare(card, null);
  }

  // 改定をまたいで比べる：保存した処方を、比べる日付の薬価で計算し直して並べる。薬価が変わった薬は黄色
  const PRICE_STATUS = { before: "まだ収載されていない", ended: "廃止されている", expired: "経過措置の期限切れ", noPair: "対になる薬の薬価が無い" };
  async function loadCompare(card, date) {
    card.dataset.compared = "1";
    const rx = prescriptions[Number(card.dataset.index)];
    const c = await api(`/api/prescriptions/${rx.id}/compare${date ? `?date=${date}` : ""}`, { background: true });
    card.querySelector("[data-compare-date]").value = c.date;
    const on = formatDate(c.date);
    const diff = c.compareDrugPoints === null ? null : c.drugPoints - c.compareDrugPoints;
    card.querySelector(".compare-out").innerHTML = `<table class="compare-table">
      <thead><tr><th>薬</th><th class="num">調剤日 ${formatDate(c.dispensedOn)}</th><th class="num">${on}</th></tr></thead>
      ${c.rps.map((rp) => `<tbody>${rp.items.map((it) => `<tr class="${it.comparePriceSen === it.priceSen ? "" : "changed"}"><td>${escapeHtml(it.name)}</td>
        <td class="num">${priceText(it.priceSen, it.unit)}</td>
        <td class="num">${it.comparePriceSen === null ? `<span class="ng">${PRICE_STATUS[it.compareStatus]}</span>` : priceText(it.comparePriceSen, it.unit)}</td></tr>`).join("")}
        <tr class="rp-sum"><td>Rp${rp.rpNo}（${rp.days}日分）</td><td class="num">${pointsText(rp.points)}</td><td class="num">${rp.comparePoints === null ? "—" : pointsText(rp.comparePoints)}</td></tr></tbody>`).join("")}
      <tfoot><tr><td>薬剤料</td><td class="num">${pointsText(c.drugPoints)}</td><td class="num">${c.compareDrugPoints === null ? "この日には使えない薬あり" : pointsText(c.compareDrugPoints)}</td></tr></tfoot>
    </table>
    <p class="compare-diff">${diff === null ? "" : diff === 0 ? `${on}の薬価でも薬剤料は変わりません` : `${on}の薬価で計算すると <strong class="${diff > 0 ? "down" : "up"}">${diff > 0 ? "−" : "+"}${pointsText(Math.abs(diff))}</strong>`}</p>`;
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
      <div class="vc-inquiry"><span class="tag ${q.changed ? "tag-warn" : ""}">${INQUIRY_KIND[q.kind]}・${q.changed ? "処方変更あり" : "変更なし"}</span><span class="about">${escapeHtml(inquiryTarget(rx, q))}</span>
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
      <span class="vc-total num" title="調剤技術料・薬学管理料・薬剤料・その他の合計と、窓口で受け取った額">合計 ${pointsText(rx.totalPoints)}・窓口 ${(rx.patientPayYen + (rx.specialFeeYen ?? 0)).toLocaleString()}円</span>
      ${rx.specialFeeYen === null ? "" : `<span class="tag tag-warn" title="長期収載品の選定療養。保険とは別に患者から受け取った額（消費税込み）">特別の料金 ${rx.specialFeeYen.toLocaleString()}円</span>`}
      <span class="tag" title="この来局のお薬手帳の提示">手帳 ${HANDBOOK_SHORT[rx.handbook]}</span>
      <span class="spacer"></span>
      <span class="meta">入力 ${escapeHtml(rx.createdBy)}</span>
    </header>
    <div class="vc-changes">${changesHtml(changes)}</div>
    ${rx.revisions.length === 0 ? "" : `<ul class="vc-revisions" aria-label="この処方を直した記録">${rx.revisions.map((v) =>
      `<li><span class="tag tag-warn">訂正</span><span class="meta">${formatDateTime(v.at)} ${escapeHtml(v.by)}</span>${escapeHtml(v.summary)}</li>`).join("")}</ul>`}
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
        一部負担金（${burdenText(rx.burdenPercent, rx.burdenReason)}）<strong>${rx.copayYen.toLocaleString()}円</strong>${rx.kohi.map((k) => ` → ${escapeHtml(k.name)}の後 <strong>${k.payYen.toLocaleString()}円</strong>`).join("")} ／ お薬手帳 ${HANDBOOK[rx.handbook]}</div>
      ${rx.specialFeeYen === null ? "" : `<div class="rp-foot">特別の料金（選定療養）：${rx.specialFeeMethod === "points"
        ? `価格差を剤ごとに点数にして × 10円 ＋ 消費税`
        : `価格差 × 投薬全量を10円単位にして ＋ 消費税`} = <strong>${rx.specialFeeYen.toLocaleString()}円</strong></div>`}
      <section class="vc-compare">
        <div class="compare-head"><h4>改定をまたいで比べる</h4>
          <label>比べる日付 <input class="input" type="date" max="9999-12-31" data-compare-date></label></div>
        <div class="compare-out"></div>
      </section>
    </div>
  </article>`;
  }

  // 疑義照会がどの剤・どの薬についてか
  function inquiryTarget(rx, q) {
    if (q.rpNo === null) return "処方全体";
    const rp = rx.rps.find((x) => x.rpNo === q.rpNo);
    const it = q.drugCode === null ? null : rp.items.find((x) => x.drugCode === q.drugCode);
    return it ? `Rp${q.rpNo} ${it.name}` : `Rp${q.rpNo} 全体`;
  }

  function recordHtml(g) {
    const rows = SOAP.filter(({ key }) => g[key]).map(({ key, letter, label }) =>
      `<dt class="${letter === "P" ? "p" : ""}" title="${escapeHtml(label)}">${letter}</dt><dd class="${letter === "P" ? "p" : ""}">${escapeHtml(g[key])}</dd>`).join("");
    return `<article class="record" data-id="${g.id}">
    <dl class="soap">${rows}</dl>
    <div class="record-meta"><span class="tag ${g.leftover === "some" ? "tag-warn" : ""}">${LEFTOVER[g.leftover]}</span>${
      g.drafted ? '<span class="tag" title="会話の文字起こし・処方から組み立てた下書きを元に書いた記録">下書きから</span>' : ""}
      <span>${escapeHtml(g.createdBy)} ${formatDateTime(g.createdAt)}</span></div>
  </article>`;
  }

  function calcHtml(rp) {
    const rows = rp.items.map((it) => {
      const cost = it.dailyYen;
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
    suggestionsFor(i);
    for (const b of visitButtons) b.disabled = false;
    renderHandover();
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
    const draw = (tables) => {
      matrixView.innerHTML = `
    <div class="legend"><span class="l-start">開始・再開</span><span class="l-change">1日量・用法・日数の変更</span><span class="l-stop">中止</span><span class="l-on">前回と同じ</span></div>
    ${tables.map((h) => `<div class="matrix-part">${h}</div>`).join("")}`;
    };
    if (matrixFold === 1) {
      // 来局をいくつかずつに分け、新しい来局の表を上にする。1つの表に入れる来局の数は、全部を1つの表にしてみて、
      // 箱の幅に収まるまで減らす（列の幅は薬の名前・量の長さで変わるので、実際に並べて測る）
      const room = matrixView.clientWidth - parseFloat(getComputedStyle(matrixView).paddingLeft) - parseFloat(getComputedStyle(matrixView).paddingRight);
      const split = (per) => {
        const tables = [];
        for (let end = all.length; end > 0; end -= per) tables.push(table(all.slice(Math.max(0, end - per), end)));
        return tables;
      };
      let per = all.length;
      draw(split(per));
      while (per > 1 && [...matrixView.querySelectorAll(".matrix")].some((t) => t.offsetWidth > room)) {
        per -= 1;
        draw(split(per));
      }
    } else {
      draw([table(all)]);
      matrixView.scrollLeft = matrixView.scrollWidth; // 入りきらないときは新しい側を見せる
    }
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

  // ---------- 患者メモ ----------
  // 分類ごとに1つの大きな欄。追加も修正もこの窓で行う。箱の中の分類の行を押すと、その分類にチェックが入った状態で開く。
  // 分類を切り替えても書きかけは窓を閉じるまで残り、保存で、変えた分類を全部書く。前の内容は消えずに残り、欄の下に並ぶ

  const noteDialog = document.querySelector("#note-dialog");
  const noteForm = document.querySelector("#note-form");
  const noteBody = noteForm.elements.body;
  const noteHistory = document.querySelector("#note-history");
  // 箱ごとに書ける分類（ほかの分類は、それぞれの箱で書く）
  const BOX_CATEGORIES = {
    cautions: ["allergy", "adverse", "disease", "concomitant"],
    next: ["handover"],
    other: ["lifestyle", "generic"],
  };
  const drafts = new Map(); // 分類 → 書きかけの内容
  let noteCategory = null;
  const savedText = (key) => noteOf(key)?.body ?? "";

  function showNoteCategory(key) {
    if (noteCategory !== null) drafts.set(noteCategory, noteBody.value);
    noteCategory = key;
    noteBody.disabled = false;
    noteBody.value = drafts.get(key) ?? savedText(key);
    noteHistory.innerHTML = (noteOf(key)?.history ?? []).map((h) =>
      `<li>${escapeHtml(h.body)}<span class="meta">${formatDate(h.createdAt.slice(0, 10))} ${escapeHtml(h.createdBy)}</span></li>`).join("");
  }

  // category：押した行の分類（無ければ、分類が1つの箱はそれ、ほかは選んでから書く）
  function openNoteDialog(box = "cautions", category = BOX_CATEGORIES[box].length === 1 ? BOX_CATEGORIES[box][0] : null) {
    const keys = BOX_CATEGORIES[box];
    document.querySelector("#note-categories").innerHTML = NOTE_CATEGORIES.filter((c) => keys.includes(c.key)).map((c) =>
      `<label><input type="radio" name="category" value="${c.key}">${escapeHtml(c.label)}</label>`).join("");
    document.querySelector("#note-dialog-title").textContent = `患者メモ（${{ cautions: "注意点", next: "申し送り", other: "生活・後発品の意向" }[box]}）`;
    clearFormErrors(noteForm);
    drafts.clear();
    noteCategory = null;
    noteBody.value = "";
    noteBody.disabled = true;
    noteHistory.innerHTML = "";
    noteDialog.showModal();
    if (category === null) {
      noteForm.querySelector('input[name="category"]').focus();
      return;
    }
    noteForm.querySelector(`input[name="category"][value="${category}"]`).checked = true;
    showNoteCategory(category);
    noteBody.focus();
    noteBody.setSelectionRange(noteBody.value.length, noteBody.value.length); // 続きを書けるように末尾へ
    noteBody.scrollTop = noteBody.scrollHeight;
  }

  noteForm.addEventListener("change", (e) => {
    if (e.target.name === "category") showNoteCategory(e.target.value);
  });

  noteForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFormErrors(noteForm);
    if (noteCategory === null) {
      noteForm.querySelector('[data-error="category"]').textContent = "分類を選んでください";
      noteForm.querySelector('input[name="category"]').focus();
      return;
    }
    drafts.set(noteCategory, noteBody.value);
    const changed = [...drafts].filter(([key, text]) => text.trim() !== savedText(key)).map(([key]) => key);
    if (changed.length === 0) {
      noteDialog.close();
      return;
    }
    await submit(noteForm, async () => {
      for (const key of changed) {
        const latest = await api(`/api/patients/${patient.id}/notes/${key}`, { method: "PUT", body: { before: savedText(key), body: drafts.get(key) } });
        notes.splice(0, notes.length, ...latest);
      }
      suggestionCache.clear();
      noteDialog.close();
      renderBand();
      renderSummary(changed);
      toast(`${changed.map((key) => NOTE_LABEL[key]).join("・")}を保存しました`);
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

  // 書く前に、その来局で何が変わったかと、それより前の留意点（P）を見せる。
  // 右側には、会話の録音・指導内容の提案・つながる薬局のメッセージを出す
  const assist = { conversation: null, drafted: false, extracted: [], suggestions: [] };

  async function openRecordDialog(i = selectedIndex) {
    if (i < 0) {
      toast("来局がまだありません。先に処方を入力してください", "error");
      return;
    }
    if (prescriptions[i].records.length > 0) { // 指導記録は1回の来局に1つ。書くのは来局カードの「未記載」の枠から
      toast(`${formatDate(prescriptions[i].dispensedOn)}の来局の指導記録は記載済みです`, "error");
      return;
    }
    recordIndex = i;
    select(i);
    const rx = prescriptions[i];
    recordForm.reset();
    recordForm.elements.leftover.value = "unchecked";
    clearFormErrors(recordForm);
    document.querySelector("#record-dialog-title").textContent = `指導記録を記載　${formatDate(rx.dispensedOn)}の来局`;
    const before = latestRecordFrom(i + 1);
    document.querySelector("#record-context").innerHTML = `
    <div><span class="label">処方の変化</span>${changesHtml(changesOf(i))}</div>
    <div><span class="label">それまでの留意点（P）</span>${before && before.record.plan
      ? `${escapeHtml(before.record.plan)}（${formatDate(before.rx.dispensedOn)}）` : "なし"}</div>`;

    assist.conversation = rx.conversations[0] ?? null; // その来局の会話がもうあれば使う
    assist.drafted = false;
    // 会話から拾ったメモの候補・指導内容の提案・下書きは、サーバーが規則で出す（規則は画面に配らない）
    assist.extracted = assist.conversation ? assist.conversation.extracted : [];
    const sg = suggestionsFor(i);
    assist.suggestions = sg.list;
    document.querySelector("#drafted-tag").hidden = true;
    renderConversation();
    renderSuggestions();
    renderLineMessages(i);
    if (templates !== null) renderTemplates();
    recordDialog.showModal();
    recordForm.elements.subjective.focus();
    // まだ届いていなければ、届いたところで窓の中に入れる（窓を閉じたり別の来局を開いたりしていたら入れない）
    if (sg.list === null) sg.promise.then(() => {
      if (!recordDialog.open || recordIndex !== i) return;
      assist.suggestions = sg.list;
      renderSuggestions();
    });
    if (templates === null) templatesLoaded.then(() => { if (recordDialog.open) renderTemplates(); });
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
      assist.extracted = c.extracted;
      renderConversation();
      renderTimeline();
      select(recordIndex, false);
      toast("会話を文字にしました。「下書きを作る」で S・O・A・P に組み立てられます");
    } finally {
      recToggle.disabled = false;
    }
  }

  // ---------- 下書き・提案・テンプレート ----------

  async function makeDraft() {
    const rx = prescriptions[recordIndex];
    const latest = latestByItem(measurements, rx.dispensedOn);
    const draft = await api("/api/calc/draft", { method: "POST", body: {
      transcript: assist.conversation?.transcript ?? "",
      changes: changesOf(recordIndex).filter((c) => c.kind !== "same" && c.kind !== "first")
        .map((c) => `${CHANGE_LABEL[c.kind]} ${c.name}${c.text ? ` ${c.text}` : ""}`),
      labs: Object.entries(latest).map(([key, v]) => ({ label: LAB[key].label, text: labText(key, v.valueMilli), measuredOn: v.measuredOn })),
      suggestions: assist.suggestions,
      on: rx.dispensedOn,
    } });
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
    if (assist.suggestions === null) {
      document.querySelector("#suggestions").innerHTML = '<li class="none">提案を出しています…</li>';
      return;
    }
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
    const title = await askText({ title: "今の内容をテンプレートに", label: "テンプレートの名前（40文字まで）", maxLength: 40, ok: "保存" });
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
      body.conversationId = assist.conversation?.id ?? null;
      body.drafted = assist.drafted;
      const record = await api(`/api/prescriptions/${rx.id}/records`, { method: "POST", body });
      rx.records.unshift(record);
      // 会話から拾ったメモのうち、チェックしたものを患者メモに足す
      const picked = [...recordForm.querySelectorAll("[data-extract]:checked")].map((c) => assist.extracted[Number(c.dataset.extract)]);
      if (picked.length) { // 分類ごとの欄の後ろに1行ずつ足す
        notes.splice(0, notes.length, ...await api(`/api/patients/${patient.id}/notes`, { method: "POST", body: { notes: picked.map((n) => ({ ...n, source: "conversation" })) } }));
        suggestionCache.clear();
        renderBand();
      }
      recordDialog.close();
      if (receptionId && rx.id === visitId) {
        toastNext("指導記録を保存しました");
        leave(`/board?focus=${receptionId}`, { refresh: true });
        return;
      }
      renderTimeline();
      renderSummary();
      select(i);
      timeline.querySelector(`.record[data-id="${record.id}"]`).classList.add("new");
      timeline.focus({ preventScroll: true });
      toast(`指導記録を保存しました${picked.length ? `（患者メモに ${picked.length}件書き足しました）` : ""}`);
    });
  });

  // 録音中に窓を閉じたり、別の画面へ移ったり（router.js の page-leave）したら、録音を捨ててマイクを止める
  function dropRecording() {
    if (!recorder) return;
    recorder.media.stop();
    for (const t of recorder.media.stream.getTracks()) t.stop();
    clearInterval(recorder.timer);
    recorder = null;
  }
  recordDialog.addEventListener("close", dropRecording);
  window.addEventListener("page-leave", dropRecording);

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
  // 患者メモの箱は、分類の行を押すとその分類にチェックが入った状態で窓が開く（行の外の余白では開かない）。検査値・体重とメモ帳は中身のどこを押しても開く（配置を変えている間は開かない）
  const BOX_INPUT = {
    cautions: (category) => openNoteDialog("cautions", category),
    next: (category) => openNoteDialog("next", category),
    other: (category) => openNoteDialog("other", category),
    labs: () => openLabDialog(),
    memo: () => memoPad.open(),
  };
  const ptGrid = document.querySelector("#pt-grid");
  ptGrid.addEventListener("click", (e) => {
    if (ptGrid.classList.contains("editing") || e.target.closest("button, a, input, select, textarea")) return;
    const row = e.target.closest("[data-note-row]");
    if (row) return BOX_INPUT[row.closest(".pbox[data-box]").dataset.box](row.dataset.category);
    const body = e.target.closest(".pbox:is([data-box=labs], [data-box=memo]) .pbox-body");
    if (body) BOX_INPUT[body.closest(".pbox").dataset.box]();
  });
  // 分類の行で Enter：その分類で開く
  ptGrid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches("[data-note-row]") || ptGrid.classList.contains("editing")) return;
    e.preventDefault();
    BOX_INPUT[e.target.closest(".pbox[data-box]").dataset.box](e.target.dataset.category);
  });

  // ---------- メモ帳 ----------
  const memoPad = setupMemoPad({ patientId: patient.id, memo, onSaved: renderMemo });
  function renderMemo(m) {
    document.querySelector("#memo").innerHTML = memoText(m);
    document.querySelector("#memo-meta").textContent = memoMeta(m);
  }
  renderMemo(memo);

  // ---------- ショートカット ----------

  // ---------- 操作の帯 ----------
  // 別の作業は薬歴の上に重なる窓で開く（overlay.js）。Esc・×・ブラウザの「戻る」で閉じ、薬歴の同じ場所に戻る
  const selected = () => prescriptions[selectedIndex];
  const openNewRx = () => openOverlay(`/rx?patient=${patient.id}`);
  const openTracing = () => openOverlay(tracingHref(selected()));
  const newRx = document.querySelector("#new-rx");
  newRx.innerHTML = icon("plus", 20);
  newRx.addEventListener("click", openNewRx);
  document.querySelector("#to-tracing").addEventListener("click", openTracing);
  // 済んだ来局の見直し・再発行（出すのは受付状況の各段階から。受付状況は前日より前の会計済みを出さないので、ここから全部の来局に届く）
  // 保存した処方を直す（会計の後でも。直す前の内容は履歴に残る）
  const openRevise = () => openOverlay(`/rx?patient=${patient.id}&edit=${selected().id}`);
  document.querySelector("#to-revise").addEventListener("click", openRevise);
  for (const [sel, path] of [["#to-inspect", "/inspect?from=patient&"], ["#to-handbook", "/handbook?"], ["#to-receipt", "/receipt?"]]) {
    document.querySelector(sel).addEventListener("click", () => openOverlay(`${path}id=${selected().id}`));
  }
  document.querySelector("#to-logs").addEventListener("click", () => openOverlay(`/logs?patient=${patient.id}`));
  for (const b of visitButtons) b.disabled = prescriptions.length === 0;

  // 指導記録を書いている間の Alt+G（下書き）
  recordForm.addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "KeyG") {
      e.preventDefault();
      makeDraft();
    }
  });

  function compareSelected() {
    if (selectedIndex < 0) return;
    const card = timeline.querySelector(`.visit-card[data-index="${selectedIndex}"]`);
    toggleCalc(card, true);
    card.querySelector("[data-compare-date]").focus();
  }

  document.addEventListener("keydown", (e) => {
    if (!e.altKey || tourActive() || document.querySelector("dialog[open]")) return;
    const actions = {
      KeyN: openNewRx,
      KeyK: () => openRecordDialog(),
      KeyM: () => openNoteDialog("cautions"),
      KeyL: openLabDialog,
      KeyE: () => memoPad.open(),
      KeyT: openTracing,
      KeyC: compareSelected,
      KeyU: () => selectedIndex >= 0 && openRevise(),
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
    const savedIndex = prescriptions.findIndex((rx) => rx.id === visitId);
    select(savedIndex >= 0 ? savedIndex : 0, false); // 開いたときは、いつも画面の一番上（注意点など）から見せる。受付から開いても、その来局は選ぶだけで送らない
    if (savedIndex >= 0 && savedId) timeline.querySelector(`.visit-card[data-index="${savedIndex}"]`).classList.add("saved");
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
        <div><b>箱</b>患者・注意点・次に確認すること・今の処方・メモ帳・検査値、処方の推移、経過。書き足すときは箱を押す</div>
        <div><b>経過の帯</b>選んだ来局の引き継ぎのチェックリストと、指導記録・トレーシングレポート</div>
      </div>`,
    },
    {
      target: "#band",
      title: "患者",
      body: "<p>氏名・カナ・生年月日・性別・負担割合・公費・お薬手帳・患者番号・最終来局日です。<strong>負担割合</strong>を押すと、保険証で確かめた割合に変えられます（年齢でありうる割合だけ選べます）。</p><p><strong>手帳</strong>は電子版・紙・持っていないのどれか。一度聞けば、次の来局の処方入力はこれが最初から選ばれています。電子版に替えた・持たなくなったと聞いたら、ここで選び直します。</p>",
    },
    {
      target: "#cautions",
      title: "注意点",
      body: `<p>アレルギー歴・副作用歴・疾患・併用薬を1つの表にまとめています。<strong>赤い行</strong>はアレルギー歴と副作用歴です。</p>
      <p>分類ごとに欄が1つです（疾患なら疾患の欄に、何行でも書けます）。<strong>行を押すと</strong>、その分類にチェックが入った状態で入力の窓が開き、書き足すのも直すのも同じ窓です（<kbd>Alt</kbd>+<kbd>M</kbd> でも開きます）。直す前の内容は消えずに残り、窓の欄の下に並びます。分類は、厚労省の通知が薬歴に記載を求める項目に合わせています。</p>`,
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
      <p><kbd>↑</kbd><kbd>↓</kbd>（帯では <kbd>←</kbd><kbd>→</kbd> も）で来局を選ぶと、その来局が大きくなり、処方の中身が出ます。経過の見出しの下の帯の操作は、この来局に対して働きます。見出しの<strong>薬剤料</strong>は、その日の薬の値段を点数にしたもの（1点＝10円）です。</p>
      <p><strong>計算の内訳を見る</strong>（<kbd>Alt</kbd>+<kbd>C</kbd>）で、点数の計算と<strong>改定をまたいだ比較</strong>が出ます。同じ処方を別の日付の薬価で計算し直して並べ、薬価が変わった薬は黄色です。比べる日付は、薬価が次に変わる日（無ければ直前に変わった日の前日）から始まり、変えられます。</p>`,
    },
    {
      target: () => document.querySelector(".no-record") ?? document.querySelector(".vc-records"),
      optional: true,
      title: "指導記録を書く",
      body: `<p>記録が無い来局には<strong>「指導記録 未記載」</strong>の枠が出ます。</p>
      <p>枠の「記載する」か <kbd>Alt</kbd>+<kbd>K</kbd> で、その来局の記録を書けます。記録は1回の来局に1つです。書く画面には、その来局の処方の変化と、それまでの留意点（P）が出ます。</p>
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
      title: "この来局の引き継ぎ",
      body: `<p>経過で選んでいる来局について、毎回同じことを確かめる<strong>チェックリスト</strong>です。</p>
      <ul>
        <li>前回の P に応えた（前回の P があるとき）・アレルギー・併用薬を照らした・処方が変わった理由を聞いた（変わったとき）・S・O・A を書いた・次回の P を書いた。どれも押して付けます</li>
      </ul>
      <p>右に<b>トレーシングレポート</b> <kbd>Alt</kbd>+<kbd>T</kbd>。<b>処方を確認</b> <kbd>Alt</kbd>+<kbd>U</kbd> で、選んだ来局の処方を見て、会計の後でも直せます（直す前の内容は来局カードに「訂正」として残ります。薬・量が変われば調剤監査から、窓口の額が変われば会計からやり直し）。選んだ来局の<b>調剤監査・お薬手帳・領収証・明細書</b>もここから開き直せます（領収証の再発行、済んだ監査の記録の確認）。前回の処方を写すのは処方入力の画面（<kbd>Alt</kbd>+<kbd>D</kbd>）からです。</p>`,
    },


  ]);
  autoStartTour();
}
