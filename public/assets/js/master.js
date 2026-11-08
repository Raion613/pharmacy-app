// マスター取込：支払基金の医薬品マスター（薬価）・調剤行為マスター（調剤報酬の点数）を読み、何が変わるかを確かめてから反映する。
// ファイルはこの画面の中で読み（master-file.js）、内用薬の行だけを 2,000 行ずつサーバーへ送る。
// 反映はサーバーが1つのトランザクションで行う。途中のどこで失敗しても、作業を消して最初の状態に戻す（薬価マスタは元のまま）。
import { renderShell, api, ApiError, escapeHtml, formatDate, formatDateTime, toast } from "./app.js";
import { formatSen } from "./yakuzairyo.js";
import { icon } from "./icons.js";
import { readMasterFile, FileFormatError } from "./master-file.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";

renderShell({ page: "master", title: "マスター取込", crumbs: [{ label: "マスター取込" }] });

const CHUNK_ROWS = 2000; // 1回に送る行数（サーバーの1つの値の上限に収める）
const $ = (s) => document.querySelector(s);
const drop = $("#drop");
const fileInput = $("#file");
const fileStatus = $("#file-status");
const publishedInput = $("#published-on");
const preview = $("#preview");
const commitButton = $("#commit");
const cancelButton = $("#cancel");
$("#drop-icon").innerHTML = icon("upload", 30);

// 取り込みの状態。idle → 読んだ（file）→ 送って確認した（pendingId, checked）→ 反映
let file = null;      // { name, kind, rows, skipped }
let pendingId = null; // サーバーの作業 ID
let checked = null;   // 確認の結果。これがある間だけ反映できる
let busy = false;     // 送信中・反映中

// ---------- このブラウザで読めるか ----------

// ZIP の展開（DecompressionStream）と Shift_JIS の読み取りが無いブラウザでは、ファイルを受け付けない
const unsupported = (() => {
  if (typeof DecompressionStream === "undefined") return "このブラウザは ZIP の展開に対応していません。Edge・Chrome・Firefox・Safari の最新版を使ってください";
  try {
    new TextDecoder("shift_jis");
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return "このブラウザは Shift_JIS の読み取りに対応していません";
  }
  return null;
})();
if (unsupported) {
  $("#unsupported").textContent = unsupported;
  $("#unsupported").hidden = false;
  $("#pick").disabled = true;
}

// ---------- 取り込み済みのマスター ----------

const KIND = { full: "全件", diff: "改定分" };
const MASTER = { drug: "医薬品", fee: "調剤行為" };

async function loadHistory(flashFile) {
  const { imports, upcoming, feeUpcoming } = await api("/api/imports");
  $("#import-count").textContent = `${imports.length}件`;
  $("#import-rows").innerHTML = imports.map((m, i) => `
    <tr class="${i === 0 ? "latest" : ""}${m.fileName === flashFile && i === 0 ? " flash" : ""}">
      <td class="num">${formatDate(m.publishedOn).replace("（", "<wbr>（")}</td>
      <td>${MASTER[m.master]} <span class="tag ${m.kind === "full" ? "tag-original" : ""}">${KIND[m.kind]}</span></td>
      <td class="sub">${escapeHtml(m.fileName)}</td>
      <td class="num">${m.rowCount.toLocaleString()}</td>
      <td class="num">${m.changedCount.toLocaleString()}</td>
      <td class="sub">${m.importedBy ? `${escapeHtml(m.importedBy)} ${formatDateTime(m.importedAt)}` : "初期データ"}</td>
    </tr>`).join("");
  const items = [
    ...upcoming.map((u) => ({ ...u, what: "薬価", unit: "品目" })),
    ...feeUpcoming.map((u) => ({ ...u, what: "調剤報酬", unit: "項目" })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  $("#upcoming-list").innerHTML = items.length === 0
    ? '<li class="sub">予定されている変更はありません</li>'
    : items.map((u) => `<li><span class="num">${formatDate(u.date)}</span>から ${u.what} <b>${u.count.toLocaleString()}</b>${u.unit}${u.ended ? `（うち使えなくなる ${u.ended}）` : ""}</li>`).join("");
}

// ---------- ファイルを読む ----------

// 誤ってページの外に落としても、ブラウザがファイルを開いて画面を離れないようにする
for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => e.preventDefault());
drop.addEventListener("dragenter", () => { if (!unsupported && !busy) drop.classList.add("over"); });
drop.addEventListener("dragover", (e) => { e.dataTransfer.dropEffect = unsupported || busy ? "none" : "copy"; });
drop.addEventListener("dragleave", (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("over"); });
drop.addEventListener("drop", (e) => {
  drop.classList.remove("over");
  if (unsupported || busy) return;
  if (e.dataTransfer.files.length !== 1) return fail(new FileFormatError("ファイルは1つだけドロップしてください"));
  start(e.dataTransfer.files[0]);
});
$("#pick").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  start(fileInput.files[0]);
  fileInput.value = ""; // 同じファイルをもう一度選んでも change が来るように
});

async function start(f) {
  await reset();
  busy = true;
  drop.classList.add("reading");
  fileStatus.hidden = false;
  fileStatus.className = "file-status";
  fileStatus.textContent = `${f.name} を読んでいます…`;
  try {
    file = { name: f.name, ...(await readMasterFile(f.name, new Uint8Array(await f.arrayBuffer()))) };
  } catch (e) {
    busy = false;
    drop.classList.remove("reading");
    return fail(e);
  }
  busy = false;
  drop.classList.remove("reading");
  const s = file.skipped;
  const skippedText = [
    s.otherForms ? `内用薬以外 ${s.otherForms.toLocaleString()}` : "",
    s.partialOtc ? `一部保険外療養（OTC 類似薬）${s.partialOtc.toLocaleString()}` : "",
    s.noYjCode ? `薬価基準コードの無いコード ${s.noYjCode}` : "",
  ].filter(Boolean).join("・");
  if (file.rows.length === 0) {
    const name = file.name;
    await reset();
    return fail(new FileFormatError(`${name}：内用薬の行がありません（${skippedText}）。取り込むものはありません`));
  }
  drop.classList.add("loaded");
  fileStatus.innerHTML = `${icon("clipboard", 15)}<b>${escapeHtml(file.name)}</b>
    ${MASTER[file.master]}マスター <span class="tag ${file.kind === "full" ? "tag-original" : ""}">${KIND[file.kind]}</span>
    ${file.master === "drug" ? "内用薬 " : ""}${file.rows.length.toLocaleString()}行${skippedText ? `<span class="sub">（取り込まない行：${skippedText}）</span>` : ""}`;
  publishedInput.value = file.publishedOn ?? "";
  if (file.publishedOn) await upload();
  else publishedInput.focus();
}

publishedInput.addEventListener("change", async () => {
  if (!file || busy) return;
  await discard(); // 公表日を変えたら、送り直して確認し直す
  if (publishedInput.value) await upload();
});

// ---------- 送って確認する ----------

async function upload() {
  busy = true;
  cancelButton.hidden = false;
  const progress = $("#progress");
  progress.hidden = false;
  const total = file.rows.length;
  const show = (sent) => {
    $("#progress-bar").style.width = `${Math.round((sent / total) * 100)}%`;
    $("#progress-text").textContent = sent < total ? `送っています ${sent.toLocaleString()} / ${total.toLocaleString()}行` : "反映すると何が変わるかを数えています…";
  };
  try {
    show(0);
    ({ id: pendingId } = await api("/api/imports", {
      method: "POST",
      body: { master: file.master, kind: file.kind, publishedOn: publishedInput.value, fileName: file.name, expectedRows: total },
    }));
    for (let i = 0; i < total; i += CHUNK_ROWS) {
      await api(`/api/imports/${pendingId}/rows`, { method: "POST", body: file.rows.slice(i, i + CHUNK_ROWS) });
      show(Math.min(i + CHUNK_ROWS, total));
    }
    const result = await api(`/api/imports/${pendingId}`);
    progress.hidden = true;
    busy = false;
    checked = result;
    renderPreview(result);
    commitButton.disabled = false;
    commitButton.focus();
  } catch (e) {
    busy = false;
    progress.hidden = true;
    await fail(e);
  }
}

const yen = (sen) => (sen === null ? "—" : `${formatSen(sen)}円`);
const pts = (x100) => (x100 === null ? "—" : `${(x100 / 100).toLocaleString()}点`);
const until = (d) => (d ? `${formatDate(d)}まで` : "");

function renderPreview(r) {
  const c = r.counts;
  const tile = (n, label, cls, title = "") => `<div class="tile ${cls}" title="${title}"><span>${label}</span><b>${n.toLocaleString()}</b></div>`;
  const table = (title, rows, cells) => rows.length === 0 ? "" : `
    <div class="examples"><div class="examples-title">${title}</div>
      <table>${rows.map((d) => `<tr><td>${escapeHtml(d.name)} <span class="sub">${d.code}</span></td>${cells(d)}</tr>`).join("")}</table></div>`;
  const notes = [
    r.olderThan ? `<p class="notice notice-warn">取り込み済み（${formatDate(r.olderThan)}）より古い公表日です。薬価だけ入れます。</p>` : "",
    c.ignored ? `<p class="hint">対象外（内用薬以外） ${c.ignored.toLocaleString()}行</p>` : "",
    c.missingBase ? `<p class="notice notice-warn">元の薬価が無いため入れない ${c.missingBase}行（前の改定分が未取込）</p>` : "",
    c.laterExists ? `<p class="hint">より新しい薬価が既にある ${c.laterExists}行（新しい方を残す）</p>` : "",
    c.disappeared ? `<p class="notice notice-warn">全件から消えたコード ${c.disappeared}品目を廃止にします（経過措置の期限の翌日、無ければ公表日から）</p>` : "",
  ].join("");
  preview.innerHTML = `
    <div class="preview-head"><b>${formatDate(r.publishedOn)} 公表の${MASTER[r.master]}マスター（${KIND[r.kind]}）</b><span>${escapeHtml(r.fileName)} ・ ${r.master === "drug" ? "内用薬 " : ""}${r.rowCount.toLocaleString()}行</span></div>
    <div class="tiles">
      ${tile(c.priceWrites, "履歴に書く行", "t-change", "その日に効いている内容と違う行")}
      ${tile(c.scheduled, "うち、これから効く", "t-add", "変更年月日が今日より後")}
      ${tile(c.newCodes, "新しいコード", "t-add")}
      ${tile(c.ends, "廃止", "t-remove", "廃止年月日の翌日から使えない")}
    </div>
    ${r.scheduled.length ? `<p class="scheduled">${r.scheduled.map((s) => `<span><b>${formatDate(s.date)}</b>から ${s.count}品目</span>`).join("")}</p>` : ""}
    ${notes}
    ${r.master === "drug"
    ? table("薬価が変わる（例）", r.examples.changes, (d) => `<td class="num">${formatDate(d.validFrom)}〜</td><td class="num">${yen(d.before)}</td><td class="arrow">→</td><td class="num">${yen(d.after)}</td><td class="sub">${until(d.transitionalAfter)}</td>`)
    : table("点数・名称が変わる（例）", r.examples.changes, (d) => `<td class="num">${formatDate(d.validFrom)}〜</td><td class="num">${pts(d.beforePoints)}</td><td class="arrow">→</td><td class="num">${pts(d.afterPoints)}</td>`)}
    ${table("新しいコード（例）", r.examples.newCodes, (d) => `<td class="num">${formatDate(d.validFrom)}〜</td><td class="num">${r.master === "drug" ? yen(d.after) : pts(d.afterPoints)}</td>`)}
    ${table("廃止（例）", r.examples.ends, (d) => `<td class="num">${formatDate(d.lastDay)}まで使える</td>`)}
    ${table("全件から消えた（例）", r.examples.disappeared, (d) => `<td class="num">${formatDate(d.validFrom)}から使えない</td>`)}
    ${c.priceWrites + c.ends + c.disappeared === 0 ? '<p class="notice notice-ok">取り込み済みの内容と同じです。反映しても薬価は変わりません。</p>' : ""}`;
  preview.classList.remove("shown");
  void preview.offsetWidth; // アニメーションを毎回最初から流す
  preview.classList.add("shown");
}

async function commit() {
  if (!checked || busy) return;
  busy = true;
  commitButton.disabled = true;
  commitButton.textContent = "反映しています…";
  try {
    const { changedCount } = await api(`/api/imports/${pendingId}/commit`, { method: "POST", body: {} });
    const name = file.name;
    pendingId = null; // 反映すると作業は消える
    toast(`${name} を反映しました（薬価の履歴 ${changedCount.toLocaleString()}行）`);
    await reset();
    await loadHistory(name);
    $("#pick").focus();
  } catch (e) {
    busy = false;
    await fail(e);
  }
}

// ---------- 中止・失敗 ----------

// 失敗したら、作業を消して最初の状態に戻し、理由を出す。薬価マスタは反映が成功するまで変わらない
async function fail(e) {
  const message = e instanceof FileFormatError || e instanceof ApiError ? e.message : "通信またはサーバーでエラーが発生しました";
  if (!(e instanceof FileFormatError || e instanceof ApiError)) console.error(e);
  await reset();
  fileStatus.hidden = false;
  fileStatus.className = "file-status";
  fileStatus.innerHTML = `<span class="notice notice-ng">${escapeHtml(message)}<br>取り込みを中止しました。薬価マスタは元のままです。</span>`;
  $("#pick").focus();
}

async function discard() {
  if (!pendingId) return;
  const id = pendingId;
  pendingId = null;
  checked = null;
  commitButton.disabled = true;
  try {
    await api(`/api/imports/${id}`, { method: "DELETE", body: {} });
  } catch (err) {
    // 消せなくても、次に取り込みを始めたときにサーバーが古い作業を消す。薬価マスタには影響しない
    console.error(err);
  }
}

async function reset() {
  await discard();
  file = null;
  checked = null;
  busy = false;
  preview.replaceChildren();
  fileStatus.hidden = true;
  $("#progress").hidden = true;
  drop.classList.remove("loaded", "reading");
  publishedInput.value = "";
  cancelButton.hidden = true;
  commitButton.disabled = true;
  commitButton.textContent = "反映する";
}

commitButton.addEventListener("click", commit);
cancelButton.addEventListener("click", async () => {
  if (busy) return;
  await reset();
  toast("取り込みを中止しました");
  $("#pick").focus();
});
document.addEventListener("keydown", async (e) => {
  if (tourActive()) return;
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    commit();
  } else if (e.key === "Escape" && file && !busy) {
    e.preventDefault();
    await reset();
    toast("取り込みを中止しました");
    $("#pick").focus();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (busy) e.preventDefault(); // 送信中・反映中に離れようとしたら確認させる
});
// 確認まで済んで反映せずに画面を離れた作業は、次に取り込みを始めたときにサーバーが消す（src/server/master-import.js の startImport）

await loadHistory();

setTour("master", [
  {
    title: "マスター取込：薬価と調剤報酬の点数を最新にする",
    body: `<p>社会保険診療報酬支払基金が公表する<strong>医薬品マスター</strong>（薬価）と<strong>調剤行為マスター</strong>（調剤報酬の点数）を入れて更新する画面です。レセプトの請求に使うのと同じマスターです。</p>
      <div class="tour-map">
        <div><b>左</b>取り込み済みのマスターと、これから効く変更</div>
        <div><b>右</b>新しいマスターのファイル</div>
        <div><b>下の帯</b>反映するボタン</div>
      </div>`,
  },
  {
    target: "#history",
    placement: "right",
    title: "取り込み済みのマスター",
    body: `<p>マスターは、全件ファイルと、公表のたびに出る改定分ファイルがあります。<strong>公表順に入れていけば、毎回最新</strong>になります。</p>
      <p>下の「これから効く薬価の変更」は、変更年月日が今日より後の品目です（例：11月1日から新しい薬価）。その日以降の調剤日から使われます。</p>`,
  },
  {
    target: "#drop",
    title: "ファイルを入れる",
    body: `<p>支払基金のページからダウンロードした <b>.zip</b>（全件）か <b>.csv</b>（改定分）を、そのままドロップします。<strong>「ファイルを選ぶ」</strong>からでも選べます。</p>
      <p>ファイルはこの画面の中で読み、内用薬の行だけを送ります。</p>`,
  },
  {
    target: ".published-field",
    title: "適用開始日はマスターが持っている",
    body: `<p>マスターは品目ごとに<strong>変更年月日</strong>（その薬価が効き始める日）・<strong>廃止年月日</strong>・<strong>経過措置の期限</strong>を持っています。薬価はその日付どおりに切り替わるので、日付を指定する必要はありません。</p>
      <p>ここに入る公表日は、マスターの新しさを比べるためだけに使います。</p>`,
  },
  {
    target: "#importer",
    placement: "left",
    title: "反映する前の確認",
    body: `<p>送り終わると、今の薬価マスタと比べて、薬価が変わる行・これから効く行・新しいコード・廃止を数え、例を出します。</p>
      <p>途中で失敗したら、<strong>送った分を消して最初の状態に戻します</strong>。薬価マスタは、反映が成功するまで一切変わりません。</p>`,
  },
  {
    target: "#commit",
    placement: "top",
    title: "反映する",
    body: "<p>確認が出ると押せるようになります（<kbd>Ctrl</kbd>+<kbd>Enter</kbd>）。反映は全部まとめて1回で行い、途中で失敗したら何も変わりません。<kbd>Esc</kbd> で中止できます。</p>",
  },
]);
autoStartTour();
