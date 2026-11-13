// 処方入力。入力中の値は state に持ち、画面はそこから描く。
// 点数・会計・小児の分量は、入力のたびにサーバーへ送って計算させ、結果だけを表示する（計算の規則は画面に配らない）。
import {
  renderShell, setCrumbs, leave, reopen, api, ApiError, escapeHtml, formatDate, today, addDays, renderPatientBand, priceText, unitText,
  pointsText, drugTags, toast, toastNext, stockText,
} from "./app.js";
import { parseQuantity, formatQuantity, formatSen } from "./format.js";
import { icon } from "./icons.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";
import { labText } from "./lab-items.js";
import { setupMemoPad } from "./memo-pad.js";
import { burdenText } from "./burden-text.js";
import { burdenCheck, openBurdenDialog } from "./burden-ui.js";
import { kohiName, kohiValidOn, hasMonthlyCap, kohiBurdenText } from "./kohi-text.js";
import { openKohiDialog } from "./kohi-ui.js";

// 画面を開くたびに router.js が呼ぶ（画面は中身だけを差し替えるので、画面の処理はこの関数の中に置く）
export default async function mount() {
  const params = new URLSearchParams(location.search);
  const patientId = params.get("patient");
  const fromId = params.get("from");
  const editId = params.get("edit"); // 保存した処方を直すとき
  const receptionId = params.get("reception") === null ? null : Number(params.get("reception")); // 受付状況の画面から入力したとき

  const screenTitle = editId ? "処方を確認" : "処方入力";
  renderShell({ page: "patients", title: screenTitle, crumbs: [{ label: "患者一覧", href: "/patients" }, { label: screenTitle }] });

  const { patient, notes, prescriptions, memo } = await api(`/api/patients/${patientId}?purpose=rx`);
  setCrumbs([
    { label: "患者一覧", href: "/patients" },
    { label: `${patient.name}（${patient.patientNo}）`, href: `/patient?id=${patient.id}` },
    { label: screenTitle },
  ]);
  renderPatientBand(document.querySelector("#band"), patient, notes, { editable: true });

  const $ = (s) => document.querySelector(s);
  const rpsEl = $("#rps");
  const prescribedInput = $("#prescribed-on");
  const dispensedInput = $("#dispensed-on");
  const suggestEl = $("#suggest");

  // ---------- 状態 ----------
  // 薬：drug・qty は調剤した（渡した）薬。rx は処方箋の記載が違うときだけ { name, qty, reason }
  // 剤：days は処方箋の日数。dispDays は調剤した日数（空なら処方箋と同じ）、daysChange は減らした根拠
  const newItem = () => ({ drug: null, query: "", qty: "", rx: null });
  // usageTouched：用法を手で選んだか（選んでいなければ、1日量から決める。defaultUsage）
  const newRp = (days = "") => ({ usage: "", usageTouched: false, days, dispDays: "", daysChange: "inquiry", items: [newItem()] });

  // 用法は決まった中から選ぶ（打たせない）
  const USAGES = ["1日1回朝食後", "1日1回夕食後", "1日1回就寝前", "1日2回朝夕食後", "1日3回毎食後", "1日3回毎食前", "1日3回毎食間"];
  const USAGE_BY_TIMES = { 1: "1日1回朝食後", 2: "1日2回朝夕食後", 3: "1日3回毎食後" };
  // 1日量から、いちばん普通の用法を決める（入力の手助け。算定の規則ではない）。
  // 1回量が割り切れる回数のうち多い方（錠・カプセルなどは1回が整数個、散剤・液剤は割り切れれば）。3錠 → 1日3回毎食後、2錠 → 1日2回朝夕食後
  function defaultUsage(rp) {
    for (const it of rp.items) {
      if (!it.drug) continue;
      let milli;
      try {
        milli = parseQuantity(it.qty);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        continue;
      }
      const countable = !["g", "mL"].includes(it.drug.unit);
      const times = [3, 2].find((n) => milli % n === 0 && (!countable || (milli / n) % 1000 === 0)) ?? 1;
      return USAGE_BY_TIMES[times];
    }
    return rp.usage;
  }
  const CHANGE_REASON = { general: "一般名処方の銘柄を選んだ", generic: "後発品に変更した", inquiry: "疑義照会で変わった" };

  const state = {
    prescribedOn: today(),
    dispensedOn: today(),
    rps: [newRp()],
    handbook: patient.handbookKind ?? "paper", // 患者のお薬手帳の形態（前に聞いた答え）。持っていない人は「提示なし」
    inquiries: [],
    feeContext: null,           // 調剤日の負担割合・公費（会計の表示に使う）
    calc: null,                 // サーバーが計算した結果（/api/calc/rx）
    kohiUse: new Map(),         // 公費ID → { use：この処方に使うか, prior：管理票のこの来局より前の今月の累計（文字のまま） }
    stock: new Map(),           // 薬コード → 今の在庫（/api/stock。記録の無い薬は null）
    kohiDefaultUse: true,       // 初めて出る公費を使う側にしておくか（直すときは、前に使った公費だけを使う）
    dirty: false,
    saving: false,
  };

  // 前回Do：過去の処方を複写し、薬価は今回の調剤日で引き直す
  if (fromId) {
    const src = prescriptions.find((rx) => rx.id === fromId);
    if (!src) throw new Error(`複写元の処方が見つかりません: ${fromId}`);
    const codes = src.rps.flatMap((rp) => rp.items.map((it) => it.drugCode));
    const [prices, stock] = await Promise.all([
      api(`/api/prices?date=${state.dispensedOn}&codes=${codes.join(",")}`),
      api(`/api/stock?codes=${codes.join(",")}`),
    ]);
    for (const [code, milli] of Object.entries(stock)) state.stock.set(code, milli);
    // 前回渡した薬・量・日数を、処方箋どおりの形で複写する（処方箋の記載との違いや疑義照会は今回の分ではないので写さない）
    state.rps = src.rps.map((rp) => ({
      ...newRp(String(rp.days)),
      usage: rp.usage,
      usageTouched: true,
      items: rp.items.map((it) => ({ ...newItem(), drug: prices[it.drugCode], query: prices[it.drugCode].name, qty: formatQuantity(it.dailyQtyMilli) })),
    }));
    const note = $("#do-note");
    note.textContent = `${formatDate(src.dispensedOn)}の処方を複写`;
    note.hidden = false;
  }

  // 処方を直す：保存した処方を、処方箋の記載・日数を減らした根拠・疑義照会・公費まで入れ直す。
  // 保存すると、直す前の内容はサーバーで履歴に残り、薬・量が変われば調剤監査から、額が変われば会計からやり直す
  const revisingRx = editId ? prescriptions.find((rx) => rx.id === editId) : null;
  if (editId && !revisingRx) throw new Error(`直す処方が見つかりません: ${editId}`);
  if (revisingRx) {
    const codes = revisingRx.rps.flatMap((rp) => rp.items.map((it) => it.drugCode));
    const [prices, stock] = await Promise.all([
      api(`/api/prices?date=${revisingRx.dispensedOn}&codes=${codes.join(",")}`),
      api(`/api/stock?codes=${codes.join(",")}`),
    ]);
    for (const [code, milli] of Object.entries(stock)) state.stock.set(code, milli);
    Object.assign(state, { prescribedOn: revisingRx.prescribedOn, dispensedOn: revisingRx.dispensedOn, handbook: revisingRx.handbook, kohiDefaultUse: false });
    state.rps = revisingRx.rps.map((rp) => ({
      ...newRp(String(rp.rxDays)),
      usage: rp.usage,
      usageTouched: true,
      dispDays: rp.days === rp.rxDays ? "" : String(rp.days),
      daysChange: rp.daysChange ?? "inquiry",
      items: rp.items.map((it) => ({
        ...newItem(), drug: prices[it.drugCode], query: prices[it.drugCode].name, qty: formatQuantity(it.dailyQtyMilli),
        rx: it.rx && { name: it.rx.name, qty: formatQuantity(it.rx.dailyQtyMilli), reason: it.rx.reason },
      })),
    }));
    state.inquiries = revisingRx.inquiries.map((q) => {
      const r = q.rpNo === null ? -1 : q.rpNo - 1;
      const i = r < 0 || q.drugCode === null ? -1 : revisingRx.rps[r].items.findIndex((it) => it.drugCode === q.drugCode);
      return {
        id: q.id, rp: r < 0 ? null : state.rps[r], item: i < 0 ? null : state.rps[r].items[i],
        kind: q.kind, content: q.content, answer: q.answer, changed: q.changed, shortReason: q.shortReason ?? "",
      };
    });
    for (const k of revisingRx.kohi) state.kohiUse.set(k.id, { use: true, prior: String(k.priorMonthYen ?? 0) });
    const note = $("#do-note");
    note.textContent = `${formatDate(revisingRx.dispensedOn)}の処方（変えると「直して保存」が押せます。直す前の内容は履歴に残ります）`;
    note.hidden = false;
    $("#do-last").remove();
    $("#save").textContent = "直して保存";
    $("#save").disabled = true; // 確かめるだけなら押せない。どこかを変えたら押せる
  }

  prescribedInput.value = state.prescribedOn;
  dispensedInput.value = state.dispensedOn;

  // ---------- 計算 ----------

  // 1行（1つの薬）の状態
  function itemInfo(it, priceOf = (d) => d) {
    if (!it.drug) return { state: it.query.trim() === "" ? "empty" : "unpicked" };
    const drug = priceOf(it.drug);
    if (!drug || drug.status !== "ok") return { state: "ng", drug };
    let milli;
    try {
      milli = parseQuantity(it.qty);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return { state: it.qty.trim() === "" ? "noqty" : "badqty", message: e.message };
    }
    return { state: "ok", calc: { drugCode: drug.code, dailyQtyMilli: milli } };
  }

  const isBlankItem = (it) => !it.drug && it.query.trim() === "" && it.qty.trim() === "";

  // 調剤した日数（空なら処方箋の日数）
  const dispensedDays = (rp) => (rp.dispDays.trim() === "" ? rp.days : rp.dispDays);

  // 1剤の状態。priceOf を差し替えると、別の日付の薬価で計算できる
  function rpInfo(rp, priceOf) {
    const items = rp.items.filter((it) => !isBlankItem(it));
    if (items.length === 0) return { state: "empty" };
    const infos = items.map((it) => itemInfo(it, priceOf));
    if (infos.some((x) => x.state === "ng")) return { state: "pending", reason: "使えない薬があります" };
    if (infos.some((x) => x.state !== "ok")) return { state: "pending", reason: "薬と1日量を入力してください" };
    const days = rp.days.trim();
    if (!/^\d{1,3}$/.test(days) || Number(days) < 1) return { state: "pending", reason: "日数を入力してください" };
    const disp = dispensedDays(rp).trim();
    if (!/^\d{1,3}$/.test(disp) || Number(disp) < 1 || Number(disp) > Number(days)) return { state: "pending", reason: "調剤した日数は処方箋の日数以下で入力してください" };
    return { state: "ok", days: Number(disp), rxDays: Number(days), daysChange: Number(disp) < Number(days) ? rp.daysChange : null };
  }


  // サーバーに送る入力。剤ごとに、1日量まで入った薬と、剤が揃っているか（点数を出すか）
  function calcBody() {
    const ctx = state.feeContext?.date === state.dispensedOn ? state.feeContext : null;
    const infos = state.rps.map((rp) => rpInfo(rp));
    return {
      patientId: patient.id,
      dispensedOn: state.dispensedOn,
      handbook: state.handbook,
      revising: revisingRx?.id ?? null, // 直している処方は、自分自身を前の来局・算定済みに数えない
      // 入力途中の剤があるとき・調剤日の負担割合と公費が届く前は、会計を出さない
      pending: infos.some((x) => x.state === "pending") || !ctx || Boolean(ctx.error),
      inquiries: state.inquiries.map((q) => ({ kind: q.kind, changed: q.changed, shortReason: q.shortReason })),
      kohi: ctx && !ctx.error ? usedKohi(ctx).map((k) => ({ kohiId: k.id, priorMonthYen: priorOf(k) })) : [],
      rps: state.rps.map((rp, r) => ({
        r,
        usage: rp.usage,
        complete: infos[r].state === "ok",
        days: infos[r].days ?? null,
        rxDays: infos[r].rxDays ?? null,
        daysChange: infos[r].daysChange ?? null,
        items: rp.items.map((it, i) => ({ i, info: itemInfo(it) })).filter((x) => x.info.state === "ok").map(({ i, info }) => ({ i, ...info.calc })),
      })),
    };
  }

  // 入力のたびに送る。後から送った分の結果だけを使う（前の結果が遅れて届いても描かない）
  let calcSeq = 0;
  async function requestCalc() {
    const seq = ++calcSeq;
    document.body.dataset.calc = "pending";
    const res = await api("/api/calc/rx", { method: "POST", body: calcBody() });
    if (seq !== calcSeq) return;
    state.calc = res;
    renderCalc();
    document.body.dataset.calc = "done";
  }

  // ---------- 描画 ----------

  function render(focus) {
    rpsEl.innerHTML = state.rps.map(rpHtml).join("");
    renderInquiryLines();
    updateAll();
    if (focus) focusField(focus);
  }

  function rpHtml(rp, r) {
    const rows = rp.items.map((it, i) => `
    <tr class="item" data-r="${r}" data-i="${i}">
      <td class="rp-no">${i === 0 ? `Rp${r + 1}` : ""}</td>
      <td>
        <input class="input drug-input" data-field="drug" data-r="${r}" data-i="${i}" value="${escapeHtml(it.query)}"
               autocomplete="off" spellcheck="false" placeholder="薬品名（ひらがな可）・医薬品コード" aria-autocomplete="list" aria-controls="suggest">
        <div class="drug-meta"></div>
      </td>
      <td>
        <div class="qty-wrap">
          <input class="input num" data-field="qty" data-r="${r}" data-i="${i}" value="${escapeHtml(it.qty)}" inputmode="decimal" autocomplete="off" aria-label="1日量">
          <span class="unit"></span>
        </div>
      </td>
      <td class="num price"></td>
      <td class="num cost"></td>
      <td><button type="button" class="row-remove" data-r="${r}" data-i="${i}" tabindex="-1" title="行を削除（Ctrl+Delete）">${icon("x", 16)}</button></td>
    </tr>${it.rx ? rxRowHtml(it, r, i) : ""}`).join("");
    return `
    <section class="rp-edit" data-r="${r}">
      <table>
        <thead><tr><th class="rp-no-col"></th><th>薬品名</th><th class="qty-col">1日量</th><th class="price-col num">薬価</th><th class="cost-col num">1日分</th><th class="del-col"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="rp-foot-edit">
        <label for="usage-${r}">用法</label>
        <select class="input usage" id="usage-${r}" data-field="usage" data-r="${r}">
          <option value="">（選ぶ）</option>${USAGES.map((u) => `<option ${rp.usage === u ? "selected" : ""}>${u}</option>`).join("")}
        </select>
        <label for="days-${r}">日数</label>
        <input class="input num days" id="days-${r}" data-field="days" data-r="${r}" value="${escapeHtml(rp.days)}" inputmode="numeric" autocomplete="off">
        <span>日分</span>
        <label for="disp-days-${r}" class="disp-label" title="残薬調整などで、処方箋より少ない日数を調剤したとき">調剤</label>
        <input class="input num days disp-days" id="disp-days-${r}" data-field="dispDays" data-r="${r}" value="${escapeHtml(rp.dispDays)}" inputmode="numeric" autocomplete="off" placeholder="同じ">
        <span>日分</span>
        <select class="input days-change" id="days-change-${r}" data-field="daysChange" data-r="${r}" aria-label="日数を減らした根拠" hidden>
          <option value="inquiry" ${rp.daysChange === "inquiry" ? "selected" : ""}>疑義照会で減らした</option>
          <option value="instruction" ${rp.daysChange === "instruction" ? "selected" : ""}>処方箋の減数調剤の指示</option>
        </select>
        <span class="rp-calc"></span>
        <button type="button" class="btn btn-ghost btn-small inq-add" data-r="${r}" tabindex="-1" title="この剤について処方医に問い合わせたとき（Alt+Q）">疑義照会</button>
      </div>
      <div class="inq-lines"></div>
    </section>`;
  }

  // 処方箋の記載が調剤した薬と違うときの行
  function rxRowHtml(it, r, i) {
    return `<tr class="rx-row" data-r="${r}" data-i="${i}">
      <td class="rp-no"></td>
      <td colspan="5">
        <div class="rx-diff-fields">
          <span class="rx-label">処方箋の記載</span>
          <input class="input rx-name" data-field="rxName" data-r="${r}" data-i="${i}" value="${escapeHtml(it.rx.name)}" placeholder="例：【般】アムロジピン錠５ｍｇ" aria-label="処方箋に書かれた薬">
          <input class="input num rx-qty" data-field="rxQty" data-r="${r}" data-i="${i}" value="${escapeHtml(it.rx.qty)}" inputmode="decimal" aria-label="処方箋の1日量">
          <select class="input rx-reason" data-field="rxReason" data-r="${r}" data-i="${i}" aria-label="違う理由">
            ${Object.entries(CHANGE_REASON).map(([v, l]) => `<option value="${v}" ${it.rx.reason === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
      </td>
    </tr>`;
  }

  function updateAll() {
    state.rps.forEach((rp, r) => {
      rp.items.forEach((_, i) => updateRow(r, i));
      updateRpCalc(r);
    });
    updateSummary();
    updateRevisionTag();
  }

  function updateRow(r, i) {
    const it = state.rps[r].items[i];
    const tr = rpsEl.querySelector(`tr.item[data-r="${r}"][data-i="${i}"]`);
    const input = tr.querySelector('[data-field="drug"]');
    const meta = tr.querySelector(".drug-meta");
    input.classList.toggle("picked", it.drug !== null);
    tr.querySelector(".unit").textContent = it.drug ? unitText(it.drug.unit) : "";

    if (it.drug === null) {
      meta.innerHTML = it.query.trim() ? '<span>候補から選んでください（<kbd>Enter</kbd>）</span>' : "";
      tr.querySelector(".price").innerHTML = "";
      tr.querySelector(".cost").textContent = "";
      tr.classList.remove("changed", "unchanged");
      return;
    }
    const d = it.drug;
    meta.innerHTML = [drugTags(d), `<span class="code">${d.code}</span>`, state.stock.has(d.code) ? stockText(state.stock.get(d.code), d.unit) : "",
      `<button type="button" class="rx-diff" data-r="${r}" data-i="${i}" tabindex="-1" aria-pressed="${it.rx !== null}" title="処方箋の記載と違う薬・量を調剤したとき（Alt+H）">${it.rx ? "処方箋と違う" : "処方箋どおり"}</button>`,
      d.status === "ok" && d.diffSen !== null ? `<span class="sentei">価格差 ${formatSen(d.diffSen)}円/${escapeHtml(unitText(d.unit))}（特別の料金の元）</span>` : "",
      d.status === "ok" ? "" : `<span class="ng">${statusMessage(d)}</span>`,
      d.status === "ok" && d.transitionalUntil ? `<span class="tag tag-warn">経過措置 ${formatDate(d.transitionalUntil)}まで</span>` : ""]
      .filter(Boolean).join(" ・ ");

    const priceCell = tr.querySelector(".price");
    if (d.status !== "ok") {
      priceCell.innerHTML = "—";
    } else {
      priceCell.innerHTML = priceText(d.priceSen, d.unit);
    }

    const info = itemInfo(it);
    if (info.state !== "ok") tr.querySelector(".cost").textContent = ""; // 1日分の額はサーバーの結果で入れる（renderCalc）
    tr.querySelector('[data-field="qty"]').classList.toggle("invalid", info.state === "badqty");
    tr.querySelector('[data-field="qty"]').title = info.state === "badqty" ? info.message : "";
  }

  function statusMessage(d) {
    return {
      before: "この調剤日ではまだ収載されていません",
      ended: "この調剤日では医薬品マスターで廃止されています",
      expired: "経過措置の使用期限を過ぎています",
      noPair: "選定療養の対になる薬の薬価がこの調剤日にありません",
    }[d.status];
  }

  function updateRpCalc(r) {
    const el = rpsEl.querySelector(`.rp-edit[data-r="${r}"] .rp-calc`);
    const rp = state.rps[r];
    const reduced = rp.dispDays.trim() !== "" && Number(rp.dispDays) < Number(rp.days);
    rpsEl.querySelector(`#days-change-${r}`).hidden = !reduced;
    const info = rpInfo(rp);
    if (info.state === "empty") {
      el.innerHTML = "";
      return;
    }
    if (info.state === "pending") {
      el.innerHTML = `<span class="pending">${info.reason}</span>`;
      return;
    }
    // 剤の点数はサーバーの結果で入れる（renderCalc）。届くまでは前の結果を残す
    if (el.querySelector(".pending")) el.innerHTML = "";
  }

  function updateSummary() {
    const pending = state.rps.some((rp) => rpInfo(rp).state === "pending");
    $("#total-note").textContent = pending ? "入力途中の剤を除く" : "";
    requestCalc();
  }

  // サーバーが計算した結果を描く
  function renderCalc() {
    const c = state.calc;
    const cost = new Map(c.items.map((x) => [`${x.r}-${x.i}`, x.costYen]));
    const rpOf = new Map(c.rps.map((x) => [x.r, x]));
    state.rps.forEach((rp, r) => {
      rp.items.forEach((_, i) => {
        const yen = cost.get(`${r}-${i}`);
        rpsEl.querySelector(`tr.item[data-r="${r}"][data-i="${i}"] .cost`).textContent = yen === undefined ? "" : `${yen}円`;
      });
      const x = rpOf.get(r);
      if (!x) return;
      rpsEl.querySelector(`.rp-edit[data-r="${r}"] .rp-calc`).innerHTML =
        `1日分 ${x.dailyYen}円 → ${x.pointsPerDay}点 × ${x.days}日 = <strong class="num">${pointsText(x.points)}</strong>`;
    });
    const done = c.rps.length > 0;
    $("#total").textContent = done ? pointsText(c.drugPoints) : "—";
    $("#total-yen").textContent = done ? `${(c.drugPoints * 10).toLocaleString()}円` : "";
    $("#rp-points").innerHTML = state.rps.map((rp, r) => {
      if (rpInfo(rp).state === "empty") return "";
      const x = rpOf.get(r);
      return `<li><span>Rp${r + 1}<span class="usage">${escapeHtml(rp.usage)}</span></span><span class="num">${x ? pointsText(x.points) : "入力途中"}</span></li>`;
    }).join("");
    renderBill(c.bill);
    renderPediatric(c.pediatric);
  }

  // ---------- 小児の分量 ----------
  // 調剤日の年齢が15歳未満なら、サーバーが薬ごとに体重当たりの量を添付文書の小児の用量と比べて返す
  const PEDS_LABEL = { ok: "範囲内", low: "少ない", high: "多い", over: "上限超え", check: "確認" };

  function renderPediatric(p) {
    const box = $("#peds");
    box.hidden = p === null;
    if (p === null) return;
    $("#peds-weight").textContent = p.weight
      ? `${p.age}歳・体重 ${labText("weight", p.weight.valueMilli)}（${formatDate(p.weight.measuredOn)}）`
      : `${p.age}歳・体重の記録なし`;
    $("#peds-list").innerHTML = p.rows.length
      ? p.rows.map((r) => `<li class="peds-${r.status}"><span class="tag">${PEDS_LABEL[r.status]}</span><b>${escapeHtml(r.name)}</b>
        <div>${escapeHtml(r.message)}</div>${r.rangeText ? `<div class="hint">${escapeHtml(r.ingredient)}：${escapeHtml(r.rangeText)}（${escapeHtml(r.source)}）</div>` : ""}</li>`).join("")
      : '<li class="none">確かめる対象の薬はまだありません</li>';
  }

  $("#peds-weight-save").addEventListener("click", async () => {
    const input = $("#peds-weight-input");
    try {
      await api(`/api/patients/${patient.id}/measurements`, {
        method: "POST", body: { measuredOn: today(), source: "manual", values: [{ item: "weight", value: input.value }] },
      });
      input.value = "";
      requestCalc();
      toast("体重を保存しました");
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 422) throw err;
      toast(err.details[0].message, "error");
      input.focus();
    }
  });

  // 会計：調剤報酬（調剤技術料・薬学管理料・薬剤料・その他）、一部負担金、選定療養の特別の料金、公費。保存時はサーバーが計算し直す
  function renderBill(b) {
    const set = (id, text) => { $(`#${id}`).textContent = text; };
    const ids = ["bill-tech", "bill-mgmt", "bill-drug", "bill-other", "bill-total", "bill-copay", "bill-special", "bill-charge"];
    const ctx = state.feeContext?.date === state.dispensedOn ? state.feeContext : null;
    const note = ctx?.error ?? b?.error ?? "";
    if (note || !b) {
      for (const id of ids) set(id, "—");
      $("#bill-lines").innerHTML = "";
      set("bill-note", note);
      return;
    }
    set("bill-note", "");
    set("bill-tech", pointsText(b.tech));
    set("bill-mgmt", pointsText(b.mgmt));
    set("bill-drug", pointsText(b.drug));
    set("bill-other", pointsText(b.other));
    set("bill-total", pointsText(b.total));
    set("bill-burden-label", `一部負担金（${burdenText(ctx.burdenPercent, ctx.burdenReason)}）`);
    set("bill-copay", `${b.copayYen.toLocaleString()}円`);
    set("bill-special", b.specialYen === null ? "—" : `${b.specialYen.toLocaleString()}円`);
    // 公費：国の公費 → 自治体の助成の順にかけ、公費ごとの後の負担を行に出す
    for (const el of $("#bill-kohi").querySelectorAll("[data-kohi-pay]")) el.textContent = "—";
    for (const s of b.kohiSteps) {
      $("#bill-kohi").querySelector(`[data-kohi-pay="${s.id}"]`).textContent = `${s.payYen.toLocaleString()}円${s.monthTotalYen === null ? "" : `（今月の累計 ${s.monthTotalYen.toLocaleString()}円）`}`;
    }
    const chargeEl = $("#bill-charge");
    const charge = `${b.chargeYen.toLocaleString()}円`;
    if (chargeEl.textContent !== charge && chargeEl.textContent !== "—") flash(chargeEl);
    chargeEl.textContent = charge;
    $("#bill-lines").innerHTML = b.lines.map((l) =>
      `<li><span>${escapeHtml(l.name)}${l.count > 1 ? ` ×${l.count}` : ""}</span><span class="num">${pointsText(l.points * l.count)}</span></li>`).join("");
  }

  async function loadFeeContext() {
    try {
      state.feeContext = await api(`/api/fee-context?patient=${patient.id}&date=${state.dispensedOn}${revisingRx ? `&exclude=${revisingRx.id}` : ""}`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 400) throw e;
      state.feeContext = { date: state.dispensedOn, error: e.message };
    }
    renderKohi();
    updateSummary();
  }

  // ---------- 公費 ----------
  // 調剤日に有効な受給者証を並べ、使うものに印を付ける（初めは全部使う）。月の上限のある公費は、自己負担上限額管理票に書かれた
  // 今月の累計（この来局より前）を入れる。初めの値は、この薬局でこの月に払った額（他の医療機関の分は入っていないので、管理票を見て直す）
  const validKohi = (ctx) => (ctx?.kohi ?? []).filter((k) => kohiValidOn(k, state.dispensedOn));
  const usedKohi = (ctx) => validKohi(ctx).filter((k) => state.kohiUse.get(k.id).use);
  const priorOf = (k) => (hasMonthlyCap(k) ? (/^\d+$/.test(state.kohiUse.get(k.id).prior.trim()) ? Number(state.kohiUse.get(k.id).prior.trim()) : 0) : null);

  function renderKohi() {
    const ctx = state.feeContext;
    const list = ctx?.error ? [] : validKohi(ctx);
    for (const k of list) {
      if (!state.kohiUse.has(k.id)) state.kohiUse.set(k.id, { use: state.kohiDefaultUse, prior: String(ctx.kohiMonthPaid[k.id] ?? 0) });
    }
    $("#bill-kohi").innerHTML = list.map((k) => {
      const u = state.kohiUse.get(k.id);
      return `<div class="kohi-row">
      <label class="kohi-use"><input type="checkbox" data-kohi-use="${k.id}" ${u.use ? "checked" : ""}><span>${escapeHtml(kohiName(k))}<small>${kohiBurdenText(k)}</small></span></label>
      ${hasMonthlyCap(k) ? `<label class="kohi-prior">管理票の今月の累計<input class="input num" data-kohi-prior="${k.id}" value="${escapeHtml(u.prior)}" inputmode="numeric" autocomplete="off">円</label>` : ""}
      <dd class="num" data-kohi-pay="${k.id}">—</dd>
    </div>`;
    }).join("");
  }
  $("#bill-kohi").addEventListener("change", (e) => {
    const id = e.target.dataset.kohiUse;
    if (id === undefined) return;
    state.kohiUse.get(Number(id)).use = e.target.checked;
    markDirty();
    updateSummary();
  });
  $("#bill-kohi").addEventListener("input", (e) => {
    const id = e.target.dataset.kohiPrior;
    if (id === undefined) return;
    state.kohiUse.get(Number(id)).prior = e.target.value;
    markDirty();
    updateSummary();
  });

  // ---------- 疑義照会 ----------
  // 薬の入力とは別の作業なので、重なる窓で書く。照会は「どの剤・どの薬について」を持ち、その剤の下に1行で出す（押すと直せる）。
  // 処方全体についての照会は、剤の並びの下にまとめて出す

  const KIND = { leftover: "残薬調整", adverse: "重複投薬・相互作用など" };
  const inqDialog = $("#inquiry-dialog");
  const inqForm = $("#inquiry-form");
  let editing = null; // 窓で直している照会（新しく書くときは null）
  let returnFocus = null; // 窓を閉じたら戻る所

  // 剤・薬を消したら、それを指していた照会は1つ上（剤全体・処方全体）を指す
  function retarget() {
    for (const q of state.inquiries) {
      if (q.rp && !state.rps.includes(q.rp)) Object.assign(q, { rp: null, item: null });
      if (q.item && (!q.rp.items.includes(q.item) || !q.item.drug)) q.item = null;
    }
  }

  const targetText = (q) => (q.rp === null ? "処方全体" : q.item ? q.item.drug.name : `Rp${state.rps.indexOf(q.rp) + 1} 全体`);

  function inquiryLine(q) {
    const n = state.inquiries.indexOf(q);
    return `<button type="button" class="inq-line" data-q="${n}" title="押すと直せます">
      <span class="inq-badge">疑義照会</span><span class="inq-kind">${KIND[q.kind]}</span>
      <span class="inq-about">${escapeHtml(targetText(q))}</span>
      <span class="inq-qa">${escapeHtml(q.content) || "<i>問い合わせた内容が空です</i>"}<span class="inq-arrow">→</span>${escapeHtml(q.answer) || "<i>回答が空です</i>"}</span>
      <span class="tag ${q.changed ? "tag-warn" : ""}">${q.changed ? "処方変更あり" : "変更なし"}</span></button>`;
  }

  function renderInquiryLines() {
    retarget();
    state.rps.forEach((rp, r) => {
      rpsEl.querySelector(`.rp-edit[data-r="${r}"] .inq-lines`).innerHTML = state.inquiries.filter((q) => q.rp === rp).map(inquiryLine).join("");
    });
    const whole = state.inquiries.filter((q) => q.rp === null);
    $("#rx-inquiries").hidden = whole.length === 0;
    $("#rx-inquiries .inq-lines").innerHTML = whole.map(inquiryLine).join("");
  }

  // 窓を開く。target はカーソルのあった剤・薬（{ rp, item }）
  let targetOptions = [];
  function openInquiry(q, target = { rp: null, item: null }) {
    retarget();
    editing = q;
    const cur = q ?? { ...target, kind: "leftover", content: "", answer: "", changed: true, shortReason: "" };
    targetOptions = [{ key: "all", label: "処方全体", rp: null, item: null }];
    state.rps.forEach((rp, r) => {
      if (rp.items.every(isBlankItem)) return;
      targetOptions.push({ key: `${r}`, label: `Rp${r + 1} 全体（${rp.usage || "用法未選択"}）`, rp, item: null });
      rp.items.forEach((it, i) => {
        if (it.drug) targetOptions.push({ key: `${r}-${i}`, label: `Rp${r + 1}　${it.drug.name}`, rp, item: it });
      });
    });
    const sel = targetOptions.find((o) => o.rp === cur.rp && o.item === cur.item) ?? targetOptions[0];
    const f = inqForm.elements;
    f.target.innerHTML = targetOptions.map((o) => `<option value="${o.key}" ${o === sel ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
    f.kind.value = cur.kind;
    f.content.value = cur.content;
    f.answer.value = cur.answer;
    f.changed.value = cur.changed ? "1" : "0";
    f.shortReason.value = cur.shortReason;
    $("#inquiry-title").textContent = q ? "疑義照会を直す" : "疑義照会を記録する";
    $("#inq-remove").hidden = q === null;
    showShortField();
    inqDialog.showModal();
    f.content.focus();
  }

  function showShortField() {
    $("#inq-short-field").hidden = !(inqForm.elements.kind.value === "leftover" && inqForm.elements.changed.value === "1");
  }
  inqForm.elements.kind.addEventListener("change", showShortField);
  inqForm.elements.changed.addEventListener("change", showShortField);

  // 照会を書くと加算が変わるので、会計を計算し直す
  function inquiriesChanged() {
    markDirty();
    renderInquiryLines();
    updateSummary();
  }

  inqForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = inqForm.elements;
    const t = targetOptions.find((o) => o.key === f.target.value);
    const leftoverChanged = f.kind.value === "leftover" && f.changed.value === "1";
    const q = editing ?? {};
    Object.assign(q, {
      rp: t.rp, item: t.item, kind: f.kind.value, content: f.content.value, answer: f.answer.value, changed: f.changed.value === "1",
      shortReason: leftoverChanged ? f.shortReason.value : "",
    });
    if (!editing) state.inquiries.push(q);
    inqDialog.close();
    inquiriesChanged();
    toast(editing ? "疑義照会を直しました" : "疑義照会を記録しました");
  });
  inqForm.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation(); // 窓が閉じた後に、画面の Ctrl+Enter（処方の保存）まで届かないように
      inqForm.requestSubmit();
    }
  });
  inqForm.querySelector("[data-close]").addEventListener("click", () => inqDialog.close());
  $("#inq-remove").addEventListener("click", () => {
    state.inquiries.splice(state.inquiries.indexOf(editing), 1);
    inqDialog.close();
    inquiriesChanged();
    toast("疑義照会を消しました");
  });
  inqDialog.addEventListener("close", () => {
    if (returnFocus?.isConnected) returnFocus.focus();
  });

  // 照会の行を押すと直す。剤の「疑義照会」はその剤について書く
  function onInquiryClick(e) {
    const line = e.target.closest(".inq-line");
    if (line) {
      const q = state.inquiries[Number(line.dataset.q)];
      returnFocus = null;
      openInquiry(q);
      returnFocus = document.querySelector(`.inq-line[data-q="${line.dataset.q}"]`);
      return;
    }
    const add = e.target.closest(".inq-add");
    if (add) {
      returnFocus = field(Number(add.dataset.r), 0, "drug");
      openInquiry(null, { rp: state.rps[add.dataset.r], item: null });
    }
  }
  rpsEl.addEventListener("click", onInquiryClick);
  $("#rx-inquiries").addEventListener("click", onInquiryClick);

  // Alt+Q：カーソルのある薬（その行の薬が選ばれていれば）か剤について書く
  function inquiryFromFocus() {
    const t = document.activeElement;
    returnFocus = t;
    const rp = t.dataset?.r === undefined ? null : state.rps[t.dataset.r];
    const it = rp && t.dataset.i !== undefined ? rp.items[t.dataset.i] : null;
    openInquiry(null, { rp, item: it?.drug ? it : null });
  }

  // 処方箋の記載と違う薬・量を調剤したときの行を開く・閉じる
  function toggleRxDiff(r, i) {
    const it = state.rps[r].items[i];
    markDirty();
    if (it.rx) {
      it.rx = null;
      render({ r, i, name: "qty" });
    } else {
      it.rx = { name: it.drug?.generalName ?? it.query, qty: it.qty, reason: "general" };
      render();
      rpsEl.querySelector(`[data-field="rxName"][data-r="${r}"][data-i="${i}"]`).focus();
    }
  }

  // 選んだ薬の中に、調剤日より後で薬価が変わる薬があれば知らせる（例：11月1日から新しい薬価）
  function updateRevisionTag() {
    const tag = $("#revision-tag");
    const next = state.rps.flatMap((rp) => rp.items).filter((it) => it.drug?.nextChangeOn).map((it) => it.drug.nextChangeOn).sort()[0];
    const text = next ? `${formatDate(next)}から薬価が変わる薬があります` : "";
    if (tag.textContent !== text && text !== "") flash(tag);
    tag.textContent = text;
    tag.hidden = text === "";
  }

  function flash(el) {
    el.classList.remove("flash");
    void el.offsetWidth; // アニメーションを最初から再生させる
    el.classList.add("flash");
  }

  function field(r, i, name) {
    if (name === "usage" || name === "days") return rpsEl.querySelector(`[data-field="${name}"][data-r="${r}"]`);
    return rpsEl.querySelector(`[data-field="${name}"][data-r="${r}"][data-i="${i}"]`);
  }

  function focusField({ r, i = 0, name }) {
    const el = field(r, i, name);
    el.focus();
    if (el instanceof HTMLInputElement) el.select(); // 用法は選ぶ欄（select）なので文字の選択は無い
  }

  // ---------- 薬の候補 ----------

  const suggest = { input: null, r: -1, i: -1, items: [], index: -1, requestNo: 0, timer: null };

  function scheduleSearch(r, i, input) {
    clearTimeout(suggest.timer);
    suggest.timer = setTimeout(() => runSearch(r, i, input), 150);
  }

  async function runSearch(r, i, input) {
    clearTimeout(suggest.timer);
    const q = state.rps[r].items[i].query.trim();
    const mine = ++suggest.requestNo;
    if (q === "") {
      closeSuggest();
      return;
    }
    const items = await api(`/api/drugs?q=${encodeURIComponent(q)}&date=${state.dispensedOn}`);
    if (mine !== suggest.requestNo || document.activeElement !== input) return; // 古い結果・別の欄に移った後の結果は捨てる
    Object.assign(suggest, { input, r, i, items });
    suggestEl.innerHTML = items.length === 0
      ? '<li class="s-empty">該当する薬はありません</li>'
      : items.map((d, k) => `
      <li role="option" data-k="${k}" ${d.status === "ok" ? "" : 'aria-disabled="true"'}>
        <span class="s-name">${escapeHtml(d.name)} ${drugTags(d)}</span>
        <span class="s-sub">${d.generalName ? `${escapeHtml(d.generalName)} ・ ` : ""}${d.code}</span>
        <span class="s-price">${d.status === "ok" ? priceText(d.priceSen, d.unit) : `<span class="s-ng">${statusMessage(d)}</span>`}</span>
        <span class="s-stock">${stockText(d.stockMilli, d.unit)}</span>
      </li>`).join("");
    suggestEl.hidden = false;
    placeSuggest();
    highlight(items.findIndex((d) => d.status === "ok"));
  }

  function placeSuggest() {
    const rect = suggest.input.getBoundingClientRect();
    suggestEl.style.left = `${Math.min(rect.left, window.innerWidth - suggestEl.offsetWidth - 8)}px`;
    const below = window.innerHeight - rect.bottom;
    if (below < 220 && rect.top > below) {
      suggestEl.style.top = "";
      suggestEl.style.bottom = `${window.innerHeight - rect.top + 2}px`;
    } else {
      suggestEl.style.bottom = "";
      suggestEl.style.top = `${rect.bottom + 2}px`;
    }
  }

  function highlight(k) {
    suggest.index = k;
    for (const li of suggestEl.querySelectorAll("li[data-k]")) {
      li.setAttribute("aria-selected", String(Number(li.dataset.k) === k));
      if (Number(li.dataset.k) === k) li.scrollIntoView({ block: "nearest" });
    }
  }

  // 使えない薬は飛ばして、上下に動かす
  function moveHighlight(step) {
    const n = suggest.items.length;
    for (let k = suggest.index + step, tries = 0; tries < n; k += step, tries++) {
      const idx = (k + n) % n;
      if (suggest.items[idx].status === "ok") {
        highlight(idx);
        return;
      }
    }
  }

  function closeSuggest() {
    suggest.requestNo++;
    suggest.input = null;
    suggestEl.hidden = true;
  }

  const suggestOpenFor = (input) => !suggestEl.hidden && suggest.input === input;

  function pick(k) {
    const drug = suggest.items[k];
    const { r, i } = suggest;
    const it = state.rps[r].items[i];
    it.drug = drug;
    it.query = drug.name;
    state.stock.set(drug.code, drug.stockMilli); // 候補を引いたときの在庫（ほかの人が保存した処方の分も引かれている）
    closeSuggest();
    markDirty();
    field(r, i, "drug").value = drug.name;
    updateRow(r, i);
    updateRpCalc(r);
    updateSummary();
    focusField({ r, i, name: "qty" });
  }

  suggestEl.addEventListener("mousedown", (e) => e.preventDefault()); // クリックで入力欄のフォーカスが外れないように
  suggestEl.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-k]");
    if (li && li.getAttribute("aria-disabled") !== "true") pick(Number(li.dataset.k));
  });
  rpsEl.addEventListener("scroll", closeSuggest);
  window.addEventListener("resize", closeSuggest);

  // ---------- 入力 ----------

  function markDirty() {
    state.dirty = true;
    if (revisingRx && !state.saving) $("#save").disabled = false;
  }

  rpsEl.addEventListener("input", (e) => {
    const t = e.target;
    const r = Number(t.dataset.r);
    const i = Number(t.dataset.i);
    const rp = state.rps[r];
    t.removeAttribute("aria-invalid");
    markDirty();
    switch (t.dataset.field) {
      case "drug": {
        const it = rp.items[i];
        it.query = t.value;
        it.drug = null; // 名前を書き換えたら、選んだ薬は外す
        updateRow(r, i);
        if (!e.isComposing) scheduleSearch(r, i, t);
        break;
      }
      case "qty":
        rp.items[i].qty = t.value;
        updateRow(r, i);
        if (!rp.usageTouched) {
          rp.usage = defaultUsage(rp);
          field(r, 0, "usage").value = rp.usage;
        }
        break;
      case "usage":
        rp.usage = t.value;
        rp.usageTouched = true;
        break;
      case "days":
        rp.days = t.value;
        break;
      case "dispDays":
        rp.dispDays = t.value;
        break;
      case "daysChange":
        rp.daysChange = t.value;
        break;
      case "rxName":
        rp.items[i].rx.name = t.value;
        break;
      case "rxQty":
        rp.items[i].rx.qty = t.value;
        break;
      case "rxReason":
        rp.items[i].rx.reason = t.value;
        break;
    }
    updateRpCalc(r);
    updateSummary();
  });

  // 日本語入力の変換を確定したときにも候補を出す
  rpsEl.addEventListener("compositionend", (e) => {
    if (e.target.dataset.field === "drug") scheduleSearch(Number(e.target.dataset.r), Number(e.target.dataset.i), e.target);
  });

  rpsEl.addEventListener("focusout", (e) => {
    if (e.target.dataset.field === "drug" && suggest.input === e.target) closeSuggest();
  });

  rpsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".row-remove");
    if (btn) removeRow(Number(btn.dataset.r), Number(btn.dataset.i));
    const diff = e.target.closest(".rx-diff");
    if (diff) toggleRxDiff(Number(diff.dataset.r), Number(diff.dataset.i));
  });

  rpsEl.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換中の Enter は確定キーなので触らない
    const t = e.target;
    const f = t.dataset.field;
    if (!f) return;
    const r = Number(t.dataset.r);
    const i = Number(t.dataset.i);

    if (e.ctrlKey && e.key === "Delete" && (f === "drug" || f === "qty")) {
      e.preventDefault();
      removeRow(r, i);
      return;
    }

    if (f === "drug") {
      if (suggestOpenFor(t)) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          moveHighlight(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (suggest.index >= 0) pick(suggest.index);
        } else if (e.key === "Escape") {
          e.preventDefault();
          closeSuggest();
        } else if (e.key === "Tab") {
          closeSuggest();
        }
        return;
      }
      if (e.key === "ArrowDown" && t.value.trim()) {
        e.preventDefault();
        runSearch(r, i, t);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onDrugEnter(r, i, t);
      }
      return;
    }

    if (e.key !== "Enter" || e.ctrlKey) return;
    e.preventDefault();
    if (f === "qty") nextRow(r, i);
    else if (f === "usage") focusField({ r, name: "days" });
    else if (f === "days") nextRp(r);
  });

  function onDrugEnter(r, i, input) {
    const rp = state.rps[r];
    const it = rp.items[i];
    if (it.drug) {
      focusField({ r, i, name: "qty" });
    } else if (it.query.trim()) {
      runSearch(r, i, input);
    } else if (rp.items.some((x) => x.drug)) {
      focusField({ r, name: "usage" }); // 空欄で Enter：この剤の薬は入れ終わった
    } else {
      $("#save").focus(); // 空の剤で Enter：処方は入れ終わった
    }
  }

  function nextRow(r, i) {
    const rp = state.rps[r];
    if (i === rp.items.length - 1) {
      rp.items.push(newItem());
      render({ r, i: i + 1, name: "drug" });
    } else {
      focusField({ r, i: i + 1, name: "drug" });
    }
  }

  function nextRp(r) {
    if (r === state.rps.length - 1) addRp();
    else focusField({ r: r + 1, i: 0, name: "drug" });
  }

  function addRp() {
    const last = state.rps[state.rps.length - 1];
    state.rps.push(newRp(last.days));
    render({ r: state.rps.length - 1, i: 0, name: "drug" });
  }

  function removeRow(r, i) {
    const rp = state.rps[r];
    rp.items.splice(i, 1);
    markDirty();
    if (rp.items.length === 0 && state.rps.length > 1) {
      state.rps.splice(r, 1);
      const pr = Math.max(0, r - 1);
      render({ r: pr, i: state.rps[pr].items.length - 1, name: "drug" });
      return;
    }
    if (rp.items.length === 0) rp.items.push(newItem());
    render({ r, i: Math.min(i, rp.items.length - 1), name: "drug" });
  }

  // ---------- 日付 ----------

  function checkDates() {
    const p = state.prescribedOn;
    const d = state.dispensedOn;
    let message = "";
    if (!p || !d) message = "日付を入力してください";
    else if (d < p) message = "調剤日が処方日より前になっています";
    else if (d > today()) message = "調剤日に未来の日付は入力できません";
    else if (d >= addDays(p, 4)) message = "処方箋の使用期間（交付日を含めて4日以内）を過ぎています";
    $("#date-error").textContent = message;
    dispensedInput.toggleAttribute("aria-invalid", message !== "");
  }

  prescribedInput.addEventListener("change", () => {
    state.prescribedOn = prescribedInput.value;
    markDirty();
    checkDates();
  });

  dispensedInput.addEventListener("change", async () => {
    if (!dispensedInput.value) return;
    state.dispensedOn = dispensedInput.value;
    markDirty();
    checkDates();
    await Promise.all([reprice(), loadFeeContext()]);
    if ((await burdenCheck(patient, burdenDate())).mismatch) await changeBurden();
  });

  // 調剤日が変わったら、入力済みの薬の薬価を引き直す。変わった薬価は一瞬光らせる
  async function reprice() {
    const codes = selectedCodes();
    if (codes.length === 0) {
      updateAll();
      return;
    }
    const prices = await api(`/api/prices?date=${state.dispensedOn}&codes=${codes.join(",")}`);
    const changed = new Set();
    for (const rp of state.rps) {
      for (const it of rp.items) {
        if (!it.drug) continue;
        const next = prices[it.drug.code];
        if (next.priceSen !== it.drug.priceSen || next.status !== it.drug.status) changed.add(it.drug.code);
        it.drug = next;
      }
    }
    updateAll();
    for (const tr of rpsEl.querySelectorAll("tr.item")) {
      const it = state.rps[tr.dataset.r].items[tr.dataset.i];
      if (it.drug && changed.has(it.drug.code)) flash(tr.querySelector(".price"));
    }
    if (changed.size > 0) toast(`調剤日の変更で ${changed.size} 品目の薬価が変わりました`);
  }

  function selectedCodes() {
    return [...new Set(state.rps.flatMap((rp) => rp.items.filter((it) => it.drug).map((it) => it.drug.code)))];
  }

  // ---------- 保存 ----------

  async function save() {
    if (state.saving) return;
    closeSuggest();
    clearErrors();

    const body = {
      patientId: patient.id, prescribedOn: state.prescribedOn, dispensedOn: state.dispensedOn, handbook: state.handbook, rps: [], receptionId, inquiries: [],
      kohi: usedKohi(state.feeContext).map((k) => ({
        kohiId: k.id, priorMonthYen: hasMonthlyCap(k) ? (/^\d+$/.test(state.kohiUse.get(k.id).prior.trim()) ? Number(state.kohiUse.get(k.id).prior.trim()) : null) : null,
      })),
    };
    const elementOf = new Map([["prescribedOn", prescribedInput], ["dispensedOn", dispensedInput], ["handbook", $("#handbook")]]);
    body.kohi.forEach((x, i) => {
      elementOf.set(`kohi.${i}`, $("#bill-kohi").querySelector(`[data-kohi-use="${x.kohiId}"]`));
      elementOf.set(`kohi.${i}.priorMonthYen`, $("#bill-kohi").querySelector(`[data-kohi-prior="${x.kohiId}"]`));
    });
    const errors = [];
    const sentNo = new Map(); // 剤 → 送る剤の番号（空の剤は送らないので、画面の Rp の番号とずれることがある）

    state.rps.forEach((rp, r) => {
      const filled = rp.items.map((it, i) => ({ it, i })).filter(({ it }) => !isBlankItem(it));
      if (filled.length === 0) return; // 空の剤は送らない
      const k = body.rps.length;
      sentNo.set(rp, k + 1);
      elementOf.set(`rps.${k}.usage`, field(r, 0, "usage"));
      elementOf.set(`rps.${k}.rxDays`, field(r, 0, "days"));
      elementOf.set(`rps.${k}.days`, field(r, 0, "dispDays"));
      elementOf.set(`rps.${k}.daysChange`, rpsEl.querySelector(`#days-change-${r}`));
      elementOf.set(`rps.${k}.items`, field(r, filled[0].i, "drug"));
      const items = [];
      filled.forEach(({ it, i }, j) => {
        elementOf.set(`rps.${k}.items.${j}.drugCode`, field(r, i, "drug"));
        elementOf.set(`rps.${k}.items.${j}.dailyQty`, field(r, i, "qty"));
        for (const [path, name] of [["name", "rxName"], ["dailyQty", "rxQty"], ["reason", "rxReason"]]) {
          elementOf.set(`rps.${k}.items.${j}.rx.${path}`, rpsEl.querySelector(`[data-field="${name}"][data-r="${r}"][data-i="${i}"]`));
        }
        if (it.drug) items.push({ drugCode: it.drug.code, dailyQty: it.qty, rx: it.rx && { name: it.rx.name, dailyQty: it.rx.qty, reason: it.rx.reason } });
        else errors.push({ el: field(r, i, "drug"), message: `Rp${r + 1}：「${it.query.trim()}」を候補から選んでください` });
      });
      const disp = Number(dispensedDays(rp));
      body.rps.push({ usage: rp.usage, rxDays: Number(rp.days), days: disp, daysChange: disp < Number(rp.days) ? rp.daysChange : null, items });
    });
    if (body.rps.length === 0) errors.push({ el: field(0, 0, "drug"), message: "薬が入力されていません" });
    retarget();
    body.inquiries = state.inquiries.map((q, n) => {
      const line = document.querySelector(`.inq-line[data-q="${n}"]`);
      for (const f of ["kind", "content", "answer", "changed", "shortReason", "target"]) elementOf.set(`inquiries.${n}.${f}`, line);
      return {
        id: q.id ?? null, rpNo: q.rp ? sentNo.get(q.rp) ?? null : null, drugCode: q.item?.drug?.code ?? null,
        kind: q.kind, content: q.content, answer: q.answer, changed: q.changed, shortReason: q.shortReason,
      };
    });
    if (errors.length > 0) {
      showErrors(errors);
      return;
    }

    // 細かい検証はサーバーに任せる（検証の規則を1か所にするため）。返ってきた項目の位置に印を付ける
    state.saving = true;
    $("#save").disabled = true;
    try {
      const saved = revisingRx
        ? await api(`/api/prescriptions/${revisingRx.id}`, { method: "PUT", body })
        : await api("/api/prescriptions", { method: "POST", body });
      state.dirty = false;
      toastNext(revisingRx ? revisedText(saved) : `処方を保存しました（合計 ${pointsText(saved.totalPoints)}・窓口で ${(saved.patientPayYen + (saved.specialFeeYen ?? 0)).toLocaleString()}円）`);
      leave(receptionId === null ? `/patient?id=${patient.id}&saved=${saved.id}` : "/board", { refresh: true });
    } catch (err) {
      state.saving = false;
      $("#save").disabled = false;
      if (!(err instanceof ApiError) || err.status !== 422) throw err;
      showErrors(err.details.map((d) => ({ el: elementOf.get(d.path) ?? null, message: labelFor(d.path, d.message) })));
    }
  }

  // 直した後に、窓口で何をするか（受け取った額との差）と、どこからやり直すか
  function revisedText(r) {
    const diff = r.receivedYen === null ? 0 : r.payYen - r.receivedYen;
    const money = diff > 0 ? `窓口で追加 ${diff.toLocaleString()}円を受け取る` : diff < 0 ? `窓口で ${(-diff).toLocaleString()}円を返す` : "";
    const redo = r.reopened.includes("audited") ? "薬が変わったので調剤監査からやり直し" : r.reopened.includes("paid") ? "会計をやり直し" : "";
    return `処方を直しました（${[`合計 ${pointsText(r.totalPoints)}・窓口で ${r.payYen.toLocaleString()}円`, money, redo].filter(Boolean).join("・")}）`;
  }

  // サーバーの項目名（rps.0.days）を、画面の言葉（Rp1：）にする
  function labelFor(path, message) {
    const m = path.match(/^rps\.(\d+)/);
    if (!m) return message;
    const rpIndexes = state.rps.map((rp, r) => (rp.items.every(isBlankItem) ? -1 : r)).filter((r) => r >= 0);
    return `Rp${rpIndexes[Number(m[1])] + 1}：${message}`;
  }

  function showErrors(errors) {
    const list = $("#error-list");
    list.innerHTML = "";
    for (const { el, message } of errors) {
      const li = document.createElement("li");
      li.textContent = message;
      if (el) {
        el.setAttribute("aria-invalid", "true");
        li.addEventListener("click", () => el.focus());
      }
      list.append(li);
    }
    $("#errors").hidden = false;
    const first = errors.find((x) => x.el);
    if (first) first.el.focus();
    toast(`保存できません（${errors.length}件）`, "error");
  }

  function clearErrors() {
    $("#errors").hidden = true;
    for (const el of document.querySelectorAll("[aria-invalid]")) {
      if (el !== dispensedInput) el.removeAttribute("aria-invalid");
    }
  }

  $("#save").addEventListener("click", save);
  $("#add-rp").addEventListener("click", addRp);

  // メモ帳（薬歴と同じもの）
  const memoPad = setupMemoPad({ patientId: patient.id, memo, onSaved: () => {} });
  $("#edit-memo").addEventListener("click", () => memoPad.open());

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || document.querySelector("dialog[open]")) return;
    if (e.altKey && e.code === "KeyE") {
      e.preventDefault();
      memoPad.open();
    } else if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.altKey && e.code === "KeyR") {
      e.preventDefault();
      addRp();
    } else if (e.altKey && e.code === "KeyQ") {
      e.preventDefault();
      inquiryFromFocus();
    } else if (e.altKey && e.code === "KeyH") {
      const t = document.activeElement;
      if ((t.dataset.field === "drug" || t.dataset.field === "qty") && state.rps[t.dataset.r].items[t.dataset.i].drug) {
        e.preventDefault();
        toggleRxDiff(Number(t.dataset.r), Number(t.dataset.i));
      }
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) e.preventDefault(); // 保存していない入力があるときは、離れる前に確認させる
  });

  $("#handbook").value = state.handbook;
  $("#handbook").addEventListener("change", (e) => {
    state.handbook = e.target.value;
    markDirty();
    updateSummary();
  });

  // ---------- 負担割合 ----------
  // 帯の「負担割合」から変える。前回の来局（か前回確かめた日）より後に年齢で割合が変わりうる日を過ぎていたら、開いたときに確認の窓を出す
  const burdenDate = () => (state.dispensedOn < today() ? state.dispensedOn : today());
  async function changeBurden() {
    const updated = await openBurdenDialog(patient, burdenDate());
    if (updated === null) return;
    Object.assign(patient, updated);
    renderPatientBand(document.querySelector("#band"), patient, notes, { editable: true });
    await loadFeeContext();
    toast(`負担割合を ${burdenText(patient.burdenPercent, patient.burdenReason)} で確定しました`);
  }
  document.querySelector("#band").addEventListener("click", async (e) => {
    if (e.target.closest("[data-burden]")) changeBurden();
    if (e.target.closest("[data-kohi]")) {
      const list = await openKohiDialog(patient);
      if (list === null) return;
      patient.kohi = list;
      renderPatientBand(document.querySelector("#band"), patient, notes, { editable: true });
      await loadFeeContext();
    }
  });

  // ---------- 開始 ----------
  checkDates();
  loadFeeContext();
  render(fromId || revisingRx ? { r: 0, i: 0, name: "qty" } : { r: 0, i: 0, name: "drug" });

  setTour("rx", [
    {
      title: "処方入力：マウスを使わずに打ち込む",
      body: `<p>処方箋の内容を入力して、薬剤料を計算・保存する画面です。<strong>キーボードだけで最後まで</strong>入力できます。</p>
      <div class="tour-map">
        <div><b>上の帯</b>患者と、アレルギー歴・副作用歴</div>
        <div><b>日付</b>処方日と調剤日</div>
        <div><b>中央</b>剤（Rp）ごとの薬・1日量・用法・日数</div>
        <div><b>右</b>会計（調剤報酬・一部負担金・窓口で受け取る額）</div>
        <div><b>下</b>保存</div>
      </div>`,
    },
    {
      target: "#band-alerts",
      title: "入力中も注意を表示",
      body: `<p>アレルギー歴・副作用歴は、入力している間もここに出し続けます。薬を選ぶ前に確かめてください。</p>`,
    },
    {
      target: ".dates",
      title: "処方日と調剤日",
      body: `<p><strong>薬価は調剤日で引きます。</strong>調剤日を改定日の前後に変えると、入力済みの薬の薬価を引き直し、変わった薬価が一瞬光ります。</p>
      <p>選んだ薬の中に、調剤日より後で薬価が変わる薬があれば、その日を札で知らせます。処方箋の使用期間（交付日を含めて4日以内）を過ぎたときもここで知らせます。</p>
      <p><strong>お薬手帳</strong>の提示の有無で、服薬管理指導料の区分が変わります。</p>`,
    },
    {
      target: ".rp-edit",
      title: "剤（Rp）の入力の流れ",
      body: `<ul>
        <li>薬品名（ひらがな・医薬品コード可）→ 候補を <kbd>↑</kbd><kbd>↓</kbd> で選んで <kbd>Enter</kbd>。薬局の採用薬（<strong>採用</strong>の札）が一番上に出ます</li>
        <li>患者が希望して先発品（長期収載品）を渡すときは、「（選）」の付いたコードを選ぶ</li>
        <li>1日量 → <kbd>Enter</kbd>：同じ剤の次の薬へ</li>
        <li>薬品名が空欄で <kbd>Enter</kbd>：用法 → 日数 → 次の剤へ。<strong>用法は1日量から選ばれています</strong>（3錠なら1日3回毎食後）。違うときは <kbd>↑</kbd><kbd>↓</kbd> で選び直します</li>
        <li>空の剤で <kbd>Enter</kbd>：保存ボタンへ</li>
      </ul>
      <p>行の削除は <kbd>Ctrl</kbd>+<kbd>Delete</kbd>。下段に、1日分の薬価から点数までの計算式が出ます。</p>
      <p>入力するのは<strong>実際に渡す薬・量・日数</strong>です。処方箋の記載と違うとき（一般名処方の銘柄選択・後発品への変更）は、その行で <kbd>Alt</kbd>+<kbd>H</kbd> を押して処方箋の記載を書きます。残薬調整で日数を減らすときは「調剤」の欄に渡す日数を入れます。</p>`,
    },
    {
      target: ".rp-edit .inq-add",
      title: "疑義照会",
      body: `<p>処方医に問い合わせたら、その剤の<strong>「疑義照会」</strong>か <kbd>Alt</kbd>+<kbd>Q</kbd> で窓を開いて記録します（<kbd>Alt</kbd>+<kbd>Q</kbd> はカーソルのある薬について）。どの薬について・種類・問い合わせた内容・処方医の回答と、回答で処方が変わったかを書きます。</p>
      <p>記録した照会はその剤の下に1行で出ます。押すと直せます。残薬調整で処方が変わった場合や、重複投薬・相互作用で処方が変わった場合は、その加算が会計に入ります。</p>`,
    },
    {
      target: "#bill",
      placement: "left",
      title: "会計",
      body: `<p>調剤技術料（調剤基本料・薬剤調製料と加算）・薬学管理料（調剤管理料・服薬管理指導料と加算）・薬剤料・その他を、調剤日の点数表で出します。点数は支払基金の調剤行為マスターから引きます。</p>
      <p>一部負担金は「合計点数 × 10円 × 負担割合」を10円未満四捨五入。選定療養の特別の料金を足した額が、<strong>窓口で受け取る額</strong>です。</p>`,
    },
    {
      target: ".total-box",
      placement: "left",
      title: "薬剤料の合計",
      body: `<p>入力するたびに計算し直します。剤ごとの点数はその下に並びます。</p>
      <p>計算の規則：1剤1日分の薬価が15円以下なら1点、15円を超えると10円またはその端数ごとに1点を加え、日数を掛けます。</p>
      <p>「（選）」の薬の<strong>特別の料金</strong>（選定療養）は、会計の「保険外」に出ます。計算方法は調剤日で変わります（令和9年3月から変更）。</p>`,
    },
    {
      target: "#peds",
      optional: true,
      placement: "left",
      title: "小児の分量",
      body: `<p>15歳未満の患者だけに出ます。薬ごとに、1日量を成分の量（mg）に直し、<strong>体重1kg当たりの量</strong>を添付文書の小児の用量と比べます。</p>
      <p>範囲内は緑、少ない・多いは黄、上限を超えると赤です。体重はこの欄から保存できます（薬歴の検査値と同じ記録）。保存は止めません。判断は薬剤師がします。</p>`,
    },
    {
      target: "#save",
      placement: "top",
      title: "保存",
      body: `<p><kbd>Ctrl</kbd>+<kbd>Enter</kbd> でどこからでも保存できます。入力の誤りは右側に一覧で出て、その欄にカーソルが移ります。</p>
      <p>保存すると薬歴の画面に戻ります。続けて、その来局の指導記録（<kbd>Alt</kbd>+<kbd>K</kbd>）を書けます。</p>
      <p>保存した後で間違いに気づいたら、受付状況の札か薬歴の来局の<strong>「処方を確認」</strong>で、保存した中身をこの画面で見られます。どこかを変えると「直して保存」が押せます（会計の後でも）。直す前の内容は消えずに残ります。</p>`,
    },
  ]);
  autoStartTour();

  // 前回の処方を写す（前回Do）。いちばん新しい来局の処方を、今の調剤日の薬価で写した処方入力に入れ直す
  function copyLast() {
    if (prescriptions.length === 0) {
      toast("この患者の前回の処方はありません", "error");
      return;
    }
    const params = new URLSearchParams(location.search);
    params.set("from", prescriptions[0].id);
    reopen(`/rx?${params}`);
  }
  if (!revisingRx) {
    document.querySelector("#do-last").addEventListener("click", copyLast);
    document.querySelector("#do-last").hidden = prescriptions.length === 0;
  }
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "KeyD" && !revisingRx && !tourActive() && !document.querySelector("dialog[open]")) {
      e.preventDefault();
      copyLast();
    }
  });

  // 開いたときの負担割合の確認（チュートリアルが流れているときは、その後に開き直したときに出る）。
  // 確認はサーバーに聞くので、待つ間もキー操作が効くよう、操作の登録を全部終えた後に聞く
  if (!tourActive() && (await burdenCheck(patient, burdenDate())).needed) changeBurden();
}
