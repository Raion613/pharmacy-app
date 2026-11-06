// トレーシングレポート（服薬情報提供書）。?patient=…&rx=… で作る画面、?id=… で印刷する画面。
// 欄は病院が公開している様式（服薬状況・残薬調整・併用薬・患者の訴え・家族からの情報・薬学的な提案・その他）に合わせた。
// 「薬歴から写す」は、空いている欄にだけ、その来局の指導記録・疑義照会・患者メモの内容を入れる（入れた後に薬剤師が直す）。
import { renderShell, setCrumbs, leave, api, ApiError, escapeHtml, formatDate, birthText, SEX, toast } from "./app.js";
import { NOTE_LABEL } from "./record-kinds.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";

const SECTIONS = [
  { key: "adherence", label: "1. 服薬状況（アドヒアランス）、次回の診察前に伝えたいこと", required: true },
  { key: "leftover", label: "1-1. 残薬調整の報告" },
  { key: "concomitant", label: "2. 併用薬（他院の薬・市販薬・健康食品）" },
  { key: "complaint", label: "3. 患者の訴え（アレルギー・副作用と思われる症状）" },
  { key: "family", label: "4. 家族・介護者からの情報" },
  { key: "proposal", label: "5. 薬学的な観点からの情報提供・提案" },
  { key: "other", label: "6. その他" },
];

const params = new URLSearchParams(location.search);
if (params.get("id")) await showPrint(params.get("id"));
else await showForm(params.get("patient"), params.get("rx"));

// ---------- 作る ----------

async function showForm(patientId, rxId) {
  renderShell({ page: "patients", title: "トレーシングレポート", crumbs: [{ label: "患者一覧", href: "/patients" }, { label: "トレーシングレポート" }] });
  const { patient, notes, prescriptions } = await api(`/api/patients/${patientId}`);
  const rx = rxId ? prescriptions.find((p) => p.id === rxId) : prescriptions[0] ?? null;
  setCrumbs([{ label: "患者一覧", href: "/patients" }, { label: `${patient.name}（${patient.patientNo}）`, href: `/patient?id=${patient.id}` },
    { label: `トレーシングレポート${rx ? `（${formatDate(rx.dispensedOn)}の来局から）` : ""}` }]);
  document.querySelector("#back").href = `/patient?id=${patient.id}`;
  const form = document.querySelector("#tracing-form");
  document.querySelector("#sections").innerHTML = SECTIONS.map((s) => `
    <div class="field"><label for="t-${s.key}">${s.label}${s.required ? '<span class="req">必須</span>' : ""}</label>
      <textarea class="input textarea" id="t-${s.key}" name="${s.key}" rows="${s.required ? 3 : 2}" maxlength="600"></textarea>
      <span class="error-text" data-error="${s.key}"></span></div>`).join("");

  function fill() {
    const put = (key, text) => {
      const el = form.elements[key];
      if (el.value.trim() === "" && text) el.value = text;
    };
    if (rx) {
      const rec = rx.records[0];
      if (rec) put("adherence", [rec.subjective, rec.objective].filter(Boolean).join("\n"));
      if (rec && rec.plan) put("proposal", rec.assessment ? `${rec.assessment}\n${rec.plan}` : rec.plan);
      put("leftover", rx.inquiries.filter((q) => q.kind === "leftover").map((q) => `${q.content}（回答：${q.answer}）`).join("\n"));
    }
    put("concomitant", notes.filter((n) => n.category === "concomitant").map((n) => n.body).join("\n"));
    put("complaint", notes.filter((n) => n.category === "allergy" || n.category === "adverse").map((n) => `${NOTE_LABEL[n.category]}：${n.body}`).join("\n"));
    toast("薬歴から、空いている欄に写しました。内容を確かめて直してください");
    form.elements.adherence.focus();
  }
  document.querySelector("#fill").addEventListener("click", fill);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    for (const el of form.querySelectorAll("[data-error]")) el.textContent = "";
    const body = Object.fromEntries(["institution", "department", "doctor", "nextVisitOn", ...SECTIONS.map((s) => s.key)].map((k) => [k, form.elements[k].value]));
    body.consent = form.elements.consent.value;
    body.prescriptionId = rx?.id ?? null;
    try {
      const { id } = await api(`/api/patients/${patient.id}/tracings`, { method: "POST", body });
      leave(`/tracing?id=${id}`);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 422) throw err;
      for (const d of err.details) form.querySelector(`[data-error="${d.path}"]`).textContent = d.message;
      (form.elements[err.details[0].path]?.[0] ?? form.elements[err.details[0].path]).focus();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (tourActive()) return;
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.altKey && e.code === "KeyW") {
      e.preventDefault();
      fill();
    }
  });
  form.elements.institution.focus();

  setTour("tracing", [
    {
      title: "トレーシングレポート：処方医への文書の報告",
      body: `<p>急ぎではないが処方医に伝えたいこと（飲み忘れ・副作用と思われる症状・併用薬・提案など）を、<strong>次の診察の前に</strong>文書で医療機関へ送ります。急ぐこと・その場で処方を変える必要があることは、疑義照会で問い合わせます。</p>
        <p>欄は、病院が公開している様式の項目に合わせました。</p>`,
    },
    {
      target: "#fill",
      title: "薬歴から写す",
      body: `<p><kbd>Alt</kbd>+<kbd>W</kbd> で、空いている欄に薬歴の内容を写します。</p>
        <ul><li>服薬状況 ← その来局の指導記録の S・O</li><li>残薬調整 ← 残薬調整の疑義照会</li><li>併用薬・患者の訴え ← 患者メモ（併用薬・アレルギー歴・副作用歴）</li><li>提案 ← 指導記録の A・P</li></ul>
        <p>写した後に、医師に伝える言葉に直してください。</p>`,
    },
    {
      target: ".panel-foot .btn-primary",
      placement: "top",
      title: "保存して印刷",
      body: "<p><kbd>Ctrl</kbd>+<kbd>Enter</kbd> で保存し、印刷の画面に移ります。保存したレポートは薬歴の「この患者の要点」から開けます（追記のみで、消せません）。</p>",
    },
  ]);
  autoStartTour();
}

// ---------- 印刷 ----------

async function showPrint(id) {
  const { report: t, patient, pharmacy } = await api(`/api/tracings/${id}`);
  document.title = "トレーシングレポート | 薬剤料計算・薬歴";
  const page = document.querySelector("#page");
  page.className = "print-page";
  document.querySelector(".sidebar").remove();
  document.querySelector(".main").remove();
  document.querySelector(".tracing-print-bar").hidden = false;
  document.querySelector("#print-back").href = `/patient?id=${patient.id}`;
  const sheet = document.querySelector("#sheet");
  sheet.hidden = false;
  const box = (on) => (on ? "■" : "□");
  sheet.innerHTML = `<section class="tracing-sheet">
    <p class="meta to">${escapeHtml(t.institution)}　御中<span class="date">報告日：${formatDate(t.createdAt.slice(0, 10))}</span></p>
    <h1>服薬情報提供書（トレーシングレポート）</h1>
    <table class="t-head">
      <tr><th>診療科</th><td>${escapeHtml(t.department)}</td><th>薬局</th><td>${escapeHtml(pharmacy.name)}</td></tr>
      <tr><th>処方医</th><td>${escapeHtml(t.doctor)}　先生　御侍史</td><th>担当薬剤師</th><td>${escapeHtml(t.createdBy)}</td></tr>
      <tr><th>患者</th><td>${escapeHtml(patient.name)}（${escapeHtml(patient.kana)}）<br>${birthText(patient.birthDate)}・${SEX[patient.sex]}・患者番号 ${escapeHtml(patient.patientNo)}</td>
        <th>電話番号</th><td>${escapeHtml(pharmacy.phone)}<br><small>${escapeHtml(pharmacy.address)}</small></td></tr>
      <tr><th>次回受診日</th><td colspan="3">${t.nextVisitOn ? formatDate(t.nextVisitOn) : "—"}</td></tr>
    </table>
    <p class="consent">${box(t.consent === "agreed")} 患者の同意のもと報告します。　${box(t.consent === "necessary")} 患者の同意はありませんが、治療上必要性があるため報告します。</p>
    <table class="t-body">${SECTIONS.map((s) => `<tr><th>${s.label}</th></tr><tr><td>${t[s.key] ? escapeHtml(t[s.key]).replaceAll("\n", "<br>") : "<span class=\"none\">特になし</span>"}</td></tr>`).join("")}</table>
    <p class="note">緊急性が高い場合や、その場で処方の変更が必要な場合は、疑義照会を行います。本書は次回の診察の参考としてお送りします。</p>
  </section>`;
  document.querySelector("#print").addEventListener("click", () => window.print());
}
