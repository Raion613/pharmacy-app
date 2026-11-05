// 在宅：通院が難しい患者の家や施設を訪問して、薬の管理・服薬の支援をする業務の画面。
//   左：在宅の患者（施設ごと）。計画書の見直しの目安と、その月の訪問回数／上限
//   右：その月の予定表。予定を選ぶと訪問の記録（＝処方医への報告書の元）を書ける
// 訪問回数の上限（月4回・週1回など）は、予定を入れるときにサーバーが確かめる（home-visit-rules.js）。
import { renderShell, api, ApiError, escapeHtml, formatDate, today, toast } from "./app.js";
import { limitsFor, weekStart, composeReport } from "./home-visit-rules.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";

renderShell({ page: "homecare", title: "在宅", crumbs: [{ label: "在宅" }] });

const $ = (s) => document.querySelector(s);
let month = new URLSearchParams(location.search).get("month") ?? today().slice(0, 7);
let data = null;

async function load() {
  data = await api(`/api/homecare?month=${month}`);
  history.replaceState(null, "", `/homecare?month=${month}`);
  render();
}

function shiftMonth(n) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  month = d.toISOString().slice(0, 7);
  load();
}

function render() {
  const [y, m] = month.split("-");
  $("#month-label").textContent = `${y}年${Number(m)}月`;
  $("#home-count").textContent = `${data.patients.length}人`;
  renderPatients();
  renderCalendar();
  $("#report-facility").innerHTML = `<option value="all">全員</option><option value="home">自宅の患者</option>${
    data.facilities.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}`;
  updateReportLink();
}

function updateReportLink() {
  $("#print-reports").href = `/homecare-print?kind=reports&month=${month}&facility=${$("#report-facility").value}`;
}
$("#report-facility").addEventListener("change", updateReportLink);

function renderPatients() {
  const groups = [{ id: null, name: "自宅" }, ...data.facilities];
  const now = today();
  $("#home-list").innerHTML = groups.map((g) => {
    const list = data.patients.filter((p) => p.facilityId === g.id);
    if (list.length === 0 && g.id === null) return "";
    return `<section class="home-group"><h3>${escapeHtml(g.name)}${g.address ? `<span class="sub">${escapeHtml(g.address)}</span>` : ""}</h3>
      ${list.length ? `<ul>${list.map((p) => {
        const visits = data.schedules.filter((s) => s.patientId === p.patientId).length;
        const { perMonth } = limitsFor(p.intensive);
        const plan = p.plan;
        const due = plan && plan.reviewDue < now;
        return `<li>
          <div class="hp-head"><a href="/patient?id=${p.patientId}" class="hp-name">${escapeHtml(p.name)}</a><span class="num hp-visits ${visits >= perMonth ? "full" : ""}" title="この月の訪問予定 / 上限">${visits} / ${perMonth}回</span></div>
          <div class="hp-sub">${escapeHtml(p.institution)} ${escapeHtml(p.doctor)} 医師${p.careManager ? `・ケアマネ ${escapeHtml(p.careManager)}` : ""}</div>
          <div class="hp-plan ${plan ? (due ? "due" : "") : "none"}">${plan
            ? `計画書 ${formatDate(plan.madeOn)}・見直しの目安 ${formatDate(plan.reviewDue)}${due ? "（過ぎています）" : ""}`
            : "計画書がまだありません"}</div>
          <button type="button" class="btn btn-small" data-plan="${p.patientId}">計画書</button>
        </li>`;
      }).join("")}</ul>` : '<p class="none">在宅の患者はいません</p>'}</section>`;
  }).join("") || '<p class="empty">在宅の患者はまだいません。「患者を登録」から登録します。</p>';
}

function renderCalendar() {
  const first = `${month}-01`;
  const start = weekStart(first);
  const cells = [];
  for (let d = new Date(`${start}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (iso.slice(0, 7) > month && d.getUTCDay() === 0) break;
    cells.push(iso);
  }
  const now = today();
  $("#calendar").innerHTML = `<div class="cal-head">${"日月火水木金土".split("").map((w) => `<span>${w}</span>`).join("")}</div>
    <div class="cal-grid">${cells.map((iso) => {
      const inMonth = iso.slice(0, 7) === month;
      const list = data.schedules.filter((s) => s.visitOn === iso);
      return `<div class="cal-day ${inMonth ? "" : "out"} ${iso === now ? "today" : ""}" data-date="${iso}">
        <span class="cal-date">${Number(iso.slice(8))}</span>
        ${list.map((s) => `<button type="button" class="cal-visit ${s.record ? "done" : iso < now ? "late" : ""}" data-schedule="${s.id}"
          title="${escapeHtml(s.patient.name)}（${escapeHtml(s.pharmacist)}）${s.record ? "記録済み" : "未記録"}">${s.record ? "✓ " : ""}${escapeHtml(s.patient.name)}<small>${escapeHtml(s.pharmacist)}</small></button>`).join("")}
      </div>`;
    }).join("")}</div>
    <p class="hint cal-legend"><span class="cal-visit done">✓ 記録済み</span><span class="cal-visit">予定</span><span class="cal-visit late">日を過ぎて未記録</span>　日付の空いた所を選ぶと、その日に予定を入れられます。</p>`;
}

// ---------- ダイアログ共通 ----------

async function submitForm(form, action) {
  for (const el of form.querySelectorAll("[data-error]")) el.textContent = "";
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await action();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 422) throw err;
    for (const d of err.details) {
      const slot = form.querySelector(`[data-error="${d.path}"]`);
      slot.textContent = slot.textContent ? `${slot.textContent} ／ ${d.message}` : d.message;
    }
    form.elements[err.details[0].path].focus();
  } finally {
    button.disabled = false;
  }
}

for (const dialog of document.querySelectorAll("dialog")) {
  const form = dialog.querySelector("form");
  form.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  form.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      form.requestSubmit();
    }
  });
}

const textOf = (form, names) => Object.fromEntries(names.map((n) => [n, form.elements[n].value]));

// ---------- 施設 ----------

$("#add-facility").addEventListener("click", () => {
  $("#facility-form").reset();
  $("#facility-dialog").showModal();
});
$("#facility-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  submitForm(form, async () => {
    const f = await api("/api/homecare/facilities", { method: "POST", body: textOf(form, ["name", "address", "phone"]) });
    $("#facility-dialog").close();
    await load();
    toast(`施設「${f.name}」を追加しました`);
  });
});

// ---------- 在宅の患者の登録 ----------

const homeForm = $("#home-form");
let searchTimer;
$("#add-home").addEventListener("click", () => {
  homeForm.reset();
  for (const el of homeForm.querySelectorAll("[data-error]")) el.textContent = "";
  $("#h-patient").innerHTML = "";
  $("#h-facility").innerHTML = `<option value="">自宅</option>${data.facilities.map((f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}`;
  homeForm.elements.startedOn.value = today();
  $("#home-dialog").showModal();
  $("#h-patient-q").focus();
});
$("#h-patient-q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const list = await api(`/api/patients?q=${encodeURIComponent(e.target.value.trim())}`);
    const registered = new Set(data.patients.map((p) => p.patientId));
    $("#h-patient").innerHTML = list.filter((p) => !registered.has(p.id))
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}（${escapeHtml(p.kana)}・${escapeHtml(p.patientNo)}）</option>`).join("");
    $("#h-patient").selectedIndex = 0;
  }, 200);
});
$("#h-patient-q").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    $("#h-patient").focus();
  }
});
homeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitForm(homeForm, async () => {
    const body = textOf(homeForm, ["institution", "doctor", "careManager", "startedOn"]);
    body.patientId = homeForm.elements.patientId.value === "" ? null : Number(homeForm.elements.patientId.value);
    body.facilityId = homeForm.elements.facilityId.value === "" ? null : Number(homeForm.elements.facilityId.value);
    body.intensive = homeForm.elements.intensive.checked;
    await api("/api/homecare/patients", { method: "POST", body });
    $("#home-dialog").close();
    await load();
    toast("在宅の患者として登録しました。続けて計画書を作ってください");
    openPlan(body.patientId);
  });
});

// ---------- 計画書 ----------

const planForm = $("#plan-form");
let planPatient = null;

async function openPlan(patientId) {
  planPatient = patientId;
  const d = await api(`/api/homecare/patients/${patientId}`);
  planForm.reset();
  for (const el of planForm.querySelectorAll("[data-error]")) el.textContent = "";
  $("#plan-title").textContent = `薬学的管理指導計画書　${d.patient.name}`;
  const last = d.plans[0];
  $("#plan-history").innerHTML = d.plans.length
    ? `<b>これまでの計画書</b>${d.plans.map((p) => `<div>${formatDate(p.madeOn)}：月${p.visitsPerMonth}回・${escapeHtml(p.intervalText)}（見直しの目安 ${formatDate(p.reviewDue)}）</div>`).join("")}`
    : "<b>計画書はまだありません</b>";
  // 見直しは前の計画書を元に直す
  planForm.elements.madeOn.value = today();
  planForm.elements.visitsPerMonth.value = last ? String(last.visitsPerMonth) : String(limitsFor(d.intensive).perMonth);
  for (const [name, key] of [["intervalText", "intervalText"], ["management", "management"], ["drugNotes", "drugNotes"], ["guidance", "guidance"]]) {
    planForm.elements[name].value = last ? last[key] : "";
  }
  $("#print-plan").hidden = !last;
  $("#print-plan").href = `/homecare-print?kind=plan&patient=${patientId}`;
  $("#plan-dialog").showModal();
  planForm.elements.management.focus();
}

$("#home-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-plan]");
  if (b) openPlan(Number(b.dataset.plan));
});
planForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitForm(planForm, async () => {
    const body = textOf(planForm, ["madeOn", "management", "drugNotes", "guidance", "intervalText"]);
    body.visitsPerMonth = Number(planForm.elements.visitsPerMonth.value);
    await api(`/api/homecare/patients/${planPatient}/plans`, { method: "POST", body });
    $("#plan-dialog").close();
    await load();
    toast("計画書を保存しました");
  });
});

// ---------- 訪問の予定 ----------

const visitForm = $("#visit-form");
function openVisit(date = today()) {
  if (data.patients.length === 0) {
    toast("先に在宅の患者を登録してください", "error");
    return;
  }
  visitForm.reset();
  for (const el of visitForm.querySelectorAll("[data-error]")) el.textContent = "";
  $("#v-patient").innerHTML = data.patients.map((p) => `<option value="${p.patientId}">${escapeHtml(p.name)}</option>`).join("");
  $("#v-pharmacist").innerHTML = data.pharmacists.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  visitForm.elements.visitOn.value = date;
  updateLimitHint();
  $("#visit-dialog").showModal();
  $("#v-patient").focus();
}
function updateLimitHint() {
  const p = data.patients.find((x) => String(x.patientId) === $("#v-patient").value);
  const { perMonth, perWeek } = limitsFor(p.intensive);
  $("#v-limit").textContent = `${p.name}さんは月${perMonth}回・週${perWeek}回までです（薬剤師1人につき週40回まで）。${p.plan ? `計画書では月${p.plan.visitsPerMonth}回・${p.plan.intervalText}。` : "計画書がまだありません。"}`;
}
$("#v-patient").addEventListener("change", updateLimitHint);
$("#add-visit").addEventListener("click", () => openVisit());
visitForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitForm(visitForm, async () => {
    const body = {
      patientId: Number(visitForm.elements.patientId.value),
      visitOn: visitForm.elements.visitOn.value,
      pharmacistId: Number(visitForm.elements.pharmacistId.value),
    };
    await api("/api/homecare/schedules", { method: "POST", body });
    $("#visit-dialog").close();
    if (body.visitOn.slice(0, 7) !== month) month = body.visitOn.slice(0, 7);
    await load();
    document.querySelector(`.cal-day[data-date="${body.visitOn}"]`).classList.add("flash");
    toast(`${formatDate(body.visitOn)}に予定を入れました`);
  });
});

// ---------- 訪問の記録 ----------

const recordForm = $("#record-form");
const RECORD_FIELDS = ["storage", "adherence", "leftover", "guidance", "report", "shared"];
let recordSchedule = null;

async function openRecord(scheduleId) {
  recordSchedule = data.schedules.find((s) => s.id === scheduleId);
  const s = recordSchedule;
  recordForm.reset();
  for (const el of recordForm.querySelectorAll("[data-error]")) el.textContent = "";
  $("#record-title").textContent = `訪問の記録　${formatDate(s.visitOn)}　${s.patient.name}`;
  const p = data.patients.find((x) => x.patientId === s.patientId);
  $("#record-context").innerHTML = `<div><span class="label">訪問先</span>${escapeHtml(s.facility ?? "自宅")}・担当 ${escapeHtml(s.pharmacist)}</div>
    <div><span class="label">計画書の指導内容</span>${p.plan ? escapeHtml(p.plan.guidance) : "計画書がまだありません"}</div>`;
  const done = s.record !== null;
  for (const n of RECORD_FIELDS) {
    recordForm.elements[n].value = done ? s.record[n] : "";
    recordForm.elements[n].readOnly = done;
  }
  $("#record-save").hidden = done;
  $("#compose-report").hidden = done;
  $("#print-one").hidden = !done;
  $("#print-one").href = `/homecare-print?kind=report&schedule=${s.id}`;
  $("#record-dialog").showModal();
  (done ? $("#print-one") : recordForm.elements.storage).focus();
}

// 訪問の記録の4欄と、その日までの最新の指導記録（薬歴）から、報告書の本文を組み立てる
async function makeReport() {
  const s = recordSchedule;
  const { prescriptions } = await api(`/api/patients/${s.patientId}`);
  const record = prescriptions.filter((rx) => rx.dispensedOn <= s.visitOn).flatMap((rx) => rx.records)[0] ?? null;
  const visit = Object.fromEntries(["storage", "adherence", "leftover", "guidance"].map((n) => [n, recordForm.elements[n].value.trim() || "（未記入）"]));
  recordForm.elements.report.value = composeReport({ visit, record });
  recordForm.elements.report.focus();
  toast(record ? "訪問の記録と、最新の指導記録から報告書の形にまとめました。内容を確かめて直してください" : "訪問の記録から報告書の形にまとめました（指導記録はまだありません）");
}
$("#compose-report").addEventListener("click", makeReport);
recordForm.addEventListener("keydown", (e) => {
  if (e.altKey && e.code === "KeyG" && !recordSchedule.record) {
    e.preventDefault();
    makeReport();
  }
});

recordForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (recordSchedule.record) return;
  submitForm(recordForm, async () => {
    await api(`/api/homecare/schedules/${recordSchedule.id}/record`, { method: "POST", body: textOf(recordForm, RECORD_FIELDS) });
    $("#record-dialog").close();
    await load();
    toast("訪問の記録を保存しました。報告書を印刷できます");
  });
});

$("#calendar").addEventListener("click", (e) => {
  const v = e.target.closest("[data-schedule]");
  if (v) {
    openRecord(Number(v.dataset.schedule));
    return;
  }
  const day = e.target.closest(".cal-day");
  if (day) openVisit(day.dataset.date);
});

$("#prev-month").addEventListener("click", () => shiftMonth(-1));
$("#next-month").addEventListener("click", () => shiftMonth(1));
document.addEventListener("keydown", (e) => {
  if (!e.altKey || tourActive() || document.querySelector("dialog[open]")) return;
  if (e.code === "KeyV") {
    e.preventDefault();
    openVisit();
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    shiftMonth(e.key === "ArrowLeft" ? -1 : 1);
  }
});

await load();

setTour("homecare", [
  {
    title: "在宅：家や施設を訪問する患者",
    body: `<p>通院が難しい患者さんの家や老人ホームを、医師の指示で訪問し、薬の管理と服薬の支援をする業務です（在宅患者訪問薬剤管理指導）。</p>
      <p>流れ：<strong>患者を登録 → 計画書を作る → 訪問を予定 → 訪問して記録 → 処方医に報告書</strong>。点数の算定はしません。</p>`,
  },
  {
    target: "#home-patients",
    placement: "right",
    title: "在宅の患者",
    body: `<p>施設ごとに並びます。右上の数字は、この月の訪問予定と上限の回数です。</p>
      <p>計画書は通知で<strong>少なくとも月1回の見直し</strong>が求められています。見直しの目安を過ぎると赤くなります。「計画書」から見直し（前の計画書を元に新しく保存）と印刷ができます。</p>`,
  },
  {
    target: "#calendar",
    placement: "left",
    title: "予定表",
    body: `<p>日付の空いた所を選ぶと、その日に予定を入れます（<kbd>Alt</kbd>+<kbd>V</kbd>）。<strong>月4回・週1回</strong>（末期の悪性腫瘍などの患者は月8回・週2回）、薬剤師1人週40回を超える予定は入りません。</p>
      <p>予定を選ぶと訪問の記録を書けます。「薬歴から報告書の形にまとめる」で、記録の欄と最新の指導記録から報告書の本文を組み立てます。</p>`,
  },
  {
    target: "#print-reports",
    title: "報告書の一括印刷",
    body: "<p>施設を選んで、その月に記録した訪問の報告書をまとめて印刷します。報告先は処方医で、ケアマネジャーがいる患者は写しの宛先も付きます。</p>",
  },
]);
autoStartTour();
