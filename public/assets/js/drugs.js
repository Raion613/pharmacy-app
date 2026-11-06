import { renderShell, api, escapeHtml, formatDate, today, priceText, drugTags, debounce, listNavigator } from "./app.js";
import { formatSen } from "./yakuzairyo.js";
import { icon } from "./icons.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";

renderShell({ page: "drugs", title: "薬価照会", crumbs: [{ label: "薬価照会" }] });

const q = document.querySelector("#q");
const on = document.querySelector("#on");
const tbody = document.querySelector("#drugs tbody");
const scroll = document.querySelector(".results-scroll");
const detail = document.querySelector("#detail");
document.querySelector("#q-icon").insertAdjacentHTML("afterbegin", icon("search", 16));
on.value = today();

// 取り込み済みのマスターは表示に使うだけなので、待たずに入力を受け付ける（読み込み直後に打った文字を落とさない）
api("/api/imports").then(({ imports }) => {
  const latest = imports[0];
  document.querySelector("#revisions").textContent = latest
    ? `薬価マスタ：医薬品マスター ${formatDate(latest.publishedOn)} 公表分まで取り込み済み（${latest.fileName}）`
    : "薬価マスタ：まだ取り込んでいません";
});

const STATUS = { before: "未収載", ended: "廃止", expired: "経過措置期限切れ", noPair: "対の薬価なし" };
const SOURCE = { full: "全件", diff: "改定分" };
let drugs = [];
let shownCode = null;

const nav = listNavigator({
  container: tbody,
  rowSelector: "tr",
  onOpen: () => {},
  onSelect: (tr) => showDetail(tr.dataset.code),
});

let requestNo = 0;
async function search() {
  const mine = ++requestNo;
  const text = q.value.trim();
  drugs = text ? await api(`/api/drugs?q=${encodeURIComponent(text)}&date=${on.value}`) : [];
  if (mine !== requestNo) return;
  document.querySelector("#count").textContent = text ? `${drugs.length}件${drugs.length === 30 ? "（先頭30件）" : ""}` : "";
  const empty = document.querySelector("#empty");
  empty.hidden = drugs.length > 0;
  if (text && drugs.length === 0) empty.textContent = "該当する薬はありません。";
  const frag = document.createDocumentFragment();
  for (const d of drugs) {
    const tr = document.createElement("tr");
    tr.dataset.code = d.code;
    if (d.status !== "ok") tr.className = "unusable";
    tr.innerHTML = `
      <td><span class="name">${escapeHtml(d.name)}</span><div class="sub">${d.generalName ? `${escapeHtml(d.generalName)} ・ ` : ""}${d.code}</div></td>
      <td>${drugTags(d)}</td>
      <td class="num">${d.status === "ok" ? priceText(d.priceSen, d.unit) : `<span class="tag tag-ng">${STATUS[d.status]}</span>`}</td>`;
    tr.addEventListener("click", () => nav.select([...tbody.children].indexOf(tr), false));
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
  nav.reset();
  const again = drugs.findIndex((d) => d.code === shownCode);
  if (again >= 0) nav.select(again, false);
}

async function showDetail(code) {
  shownCode = code;
  const d = await api(`/api/drugs/${code}`);
  if (shownCode !== code) return;
  const date = on.value;
  const current = d.history.findLast((h) => h.validFrom <= date);
  const rows = d.history.map((h, k) => {
    const prev = d.history[k - 1];
    let diff = "";
    if (prev && prev.priceSen !== null && h.priceSen !== null && prev.priceSen !== h.priceSen) {
      const delta = h.priceSen - prev.priceSen;
      diff = `<span class="${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : "−"}${formatSen(Math.abs(delta))}円</span>`;
    }
    const until = h.transitionalUntil ? `${formatDate(h.transitionalUntil)}まで` : "";
    return `<tr class="${h === current ? "current" : "other"}">
      <td>${formatDate(h.validFrom)}〜</td>
      <td class="num">${h.priceSen === null ? '<span class="tag tag-ng">廃止</span>' : priceText(h.priceSen, d.unit)}</td>
      <td class="num">${diff}</td>
      <td>${until}</td>
      <td>${formatDate(h.source.publishedOn)} 公表の${SOURCE[h.source.kind]}<div class="sub">${escapeHtml(h.source.fileName)}</div></td>
    </tr>`;
  }).join("");
  detail.innerHTML = `
    <div class="panel-head">薬価の履歴</div>
    <div class="detail-body">
      <div><div class="drug-title">${escapeHtml(d.name)}</div><div>${drugTags(d)}</div></div>
      <dl class="drug-props">
        <dt>一般名</dt><dd>${d.generalName ? escapeHtml(d.generalName) : "—"}</dd>
        <dt>薬価の単位</dt><dd>${d.unit === "" ? "規格単位（品名の規格）1つ" : `1${escapeHtml(d.unit)}`} 当たり</dd>
        <dt>医薬品コード</dt><dd>${d.code}</dd>
        <dt>薬価基準コード</dt><dd>${d.yjCode}</dd>
        ${pairHtml(d, date)}
      </dl>
      <table class="history">
        <thead><tr><th>適用開始日</th><th class="num">薬価</th><th class="num">前回比</th><th>経過措置</th><th>取り込んだマスター</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="hint">${current ? "" : `${formatDate(date)} 時点では未収載`}</p>
    </div>`;
}

// 選定療養（患者希望）のコードは、対になる長期収載品と、基準日の価格差を出す
function pairHtml(d, date) {
  if (d.sentei !== 2) return "";
  const own = d.history.findLast((h) => h.validFrom <= date);
  const pair = d.pair.history.findLast((h) => h.validFrom <= date);
  const diff = own?.priceSen != null && pair?.priceSen != null ? `${formatSen(pair.priceSen - own.priceSen)}円` : "—";
  return `<dt>対の長期収載品</dt><dd>${escapeHtml(d.pair.name)}（${d.pair.code}）${pair?.priceSen != null ? ` ${priceText(pair.priceSen, d.unit)}` : ""}</dd>
    <dt>価格差</dt><dd>${diff}<span class="sub">（長期収載品と後発品の価格差の1/2。令和8年5月までは1/4。特別の料金の元になる）</span></dd>`;
}

q.addEventListener("input", debounce(search, 200));
on.addEventListener("change", () => {
  search();
  if (shownCode) showDetail(shownCode);
});
q.addEventListener("keydown", (e) => {
  if (e.isComposing || tbody.rows.length === 0) return;
  if (e.key === "ArrowDown" || e.key === "Enter") {
    e.preventDefault();
    scroll.focus();
    nav.select(0);
  }
});
scroll.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && nav.index <= 0) {
    e.preventDefault();
    q.focus();
    return;
  }
  nav.handleKey(e);
});
document.addEventListener("keydown", (e) => {
  if (tourActive()) return;
  if (e.key === "/" && document.activeElement !== q && document.activeElement !== on) {
    e.preventDefault();
    q.focus();
    q.select();
  }
});

setTour("drugs", [
  {
    title: "薬価照会：薬価マスタの中身を見る",
    body: `<p>取り込んだ支払基金の医薬品マスターを、薬ごとに調べる画面です。同じ薬の薬価が、いつからいくらに変わったかを確かめられます。</p>
      <div class="tour-map">
        <div><b>上</b>薬の検索と、基準日</div>
        <div><b>左</b>見つかった薬と、基準日の薬価</div>
        <div><b>右</b>選んだ薬の、改定ごとの薬価</div>
        <div><b>下の帯</b>取り込み済みのマスター</div>
      </div>`,
  },
  {
    target: ".search-head",
    title: "検索と基準日",
    body: `<p>品名・一般名（ひらがな可）・医薬品コード・薬価基準コードの先頭で探せます。</p>
      <p><strong>基準日</strong>を変えると、その日に有効だった薬価で一覧を出し直します（例：2026-03-31 にすると改定前の薬価）。</p>`,
  },
  {
    target: ".drug-results",
    placement: "right",
    title: "見つかった薬",
    body: `<p>基準日に使える薬を先に並べます。未収載・廃止・経過措置の期限切れは、赤い札で理由を示します。</p>
      <p>長期収載品は、患者が希望したとき用の「（選）」のコードが別にあります（<strong>選定療養</strong>の札）。</p>
      <p><kbd>↓</kbd> で一覧に入り、<kbd>↑</kbd><kbd>↓</kbd> で選ぶと右に履歴が出ます。</p>`,
  },
  {
    target: "#detail",
    placement: "left",
    title: "改定ごとの薬価",
    body: `<p>マスターの変更年月日ごとの薬価・前回比・経過措置の期限と、どのマスターから入ったかです。</p>
      <p>基準日に<strong>効いている行を青で強調</strong>し、他の行は控えめに表示します。処方の計算は、この「その日に効いている行」を使います。</p>`,
  },
  {
    target: "#revisions",
    placement: "top",
    title: "取り込み済みのマスター",
    body: "<p>どの公表日のマスターまで入っているかです。新しいマスターは左の<strong>「マスター取込」</strong>画面から入れます。</p>",
  },
]);
autoStartTour();
