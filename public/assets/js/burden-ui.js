// 負担割合の窓。患者の欄の「負担割合」から開いて変える／受付・処方入力のときに、年齢で割合が変わりうる日を過ぎていたら自動で開く。
import { api, ApiError, escapeHtml, formatDate } from "./app.js";
import { BURDENS, allowedBurdens, burdenEvents, ageParts, burdenLongText, burdenText } from "./burden.js";

// 確認が要るか：前回確かめた日（前回の来局か、窓で確かめた日の遅い方）より後に割合が変わりうる日が来た／今の割合がこの年齢でありえない
export function burdenCheck(patient, date) {
  const since = [patient.lastDispensedOn, patient.burdenCheckedOn].filter((d) => d !== null).sort().at(-1) ?? null;
  const events = since === null ? [] : burdenEvents(patient.birthDate, since, date);
  const mismatch = !allowedBurdens(patient.birthDate, date).includes(patient.burdenPercent);
  return { events, mismatch, needed: events.length > 0 || mismatch };
}

const REASON = {
  30: "小学生〜69歳／70歳以上で現役並みの所得",
  20: "小学校に上がる前／70〜74歳／75歳以上で一定以上の所得",
  10: "75歳以上（後期高齢者医療）",
  0: "生活保護（医療券・調剤券で来局）",
};

let dialog = null;
function ensureDialog() {
  if (dialog) return dialog;
  document.body.insertAdjacentHTML("beforeend", `
    <dialog id="burden-dialog" aria-labelledby="burden-title">
      <form id="burden-form" novalidate>
        <div class="panel-head" id="burden-title"></div>
        <div class="dialog-body">
          <p class="burden-who" id="burden-who"></p>
          <ul class="burden-events" id="burden-events"></ul>
          <p class="burden-mismatch" id="burden-mismatch" hidden></p>
          <div class="field">
            <span class="label" id="burden-label">保険証（マイナ保険証の資格確認）に書かれた負担割合</span>
            <div class="burden-choices" role="radiogroup" aria-labelledby="burden-label" id="burden-choices"></div>
            <span class="error-text" data-error="burdenPercent"></span>
          </div>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" data-close>閉じる <kbd>Esc</kbd></button>
          <button type="submit" class="btn btn-primary">この割合で確定 <kbd>Enter</kbd></button>
        </div>
      </form>
    </dialog>`);
  dialog = document.querySelector("#burden-dialog");
  return dialog;
}

// date：その割合を確かめる日（処方入力は調剤日、それ以外は今日）。確定すると新しい患者情報、閉じると null を返す
export function openBurdenDialog(patient, date) {
  const d = ensureDialog();
  const form = d.querySelector("form");
  const { events, mismatch } = burdenCheck(patient, date);
  const allowed = allowedBurdens(patient.birthDate, date);
  const age = ageParts(patient.birthDate, date);
  d.querySelector("#burden-title").textContent = events.length || mismatch ? "負担割合の確認" : "負担割合を変える";
  d.querySelector("#burden-who").innerHTML = `<b>${escapeHtml(patient.name)}</b>さん　${formatDate(date)}時点で <b>${age.years}歳${age.months}か月</b>
    ・今の登録 <b>${burdenLongText(patient.burdenPercent)}</b>${patient.lastDispensedOn ? `・前回の来局 ${formatDate(patient.lastDispensedOn)}` : ""}`;
  d.querySelector("#burden-events").innerHTML = events.map((e) => `<li><span class="on">${formatDate(e.on)}</span>${escapeHtml(e.text)}</li>`).join("");
  const mismatchEl = d.querySelector("#burden-mismatch");
  mismatchEl.hidden = !mismatch;
  mismatchEl.textContent = `今の登録の ${burdenText(patient.burdenPercent)} は、この年齢ではありえません。割合を選び直してください。`;
  const insured = allowed.filter((p) => p !== 0);
  // 今の割合がありうるならそれ、ありえず年齢で1つに決まるならそれを選んでおく（70歳以上は所得で決まるので選ばない）
  const preset = allowed.includes(patient.burdenPercent) ? patient.burdenPercent : insured.length === 1 ? insured[0] : null;
  d.querySelector("#burden-choices").innerHTML = BURDENS.map((p) => {
    const ok = allowed.includes(p);
    return `<label class="${ok ? "" : "disabled"}"><input type="radio" name="burdenPercent" value="${p}" ${ok ? "" : "disabled"} ${p === preset ? "checked" : ""}>
      <b>${burdenLongText(p)}</b><span class="why">${ok ? REASON[p] : "この年齢ではありえない"}</span></label>`;
  }).join("");
  form.querySelector("[data-error]").textContent = "";

  return new Promise((resolve) => {
    let result = null;
    const onSubmit = async (e) => {
      e.preventDefault();
      const checked = form.querySelector('input[name="burdenPercent"]:checked');
      if (!checked) {
        form.querySelector("[data-error]").textContent = "負担割合を選んでください";
        return;
      }
      try {
        result = await api(`/api/patients/${patient.id}/burden`, { method: "PUT", body: { burdenPercent: Number(checked.value), date } });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 422) throw err;
        form.querySelector("[data-error]").textContent = err.details[0].message;
        return;
      }
      d.close();
    };
    const onKey = (e) => {
      if (e.key === "Enter" && e.target.name === "burdenPercent") {
        e.preventDefault();
        form.requestSubmit();
      }
    };
    const onCloseClick = () => d.close();
    form.addEventListener("submit", onSubmit);
    form.addEventListener("keydown", onKey);
    form.querySelector("[data-close]").addEventListener("click", onCloseClick);
    d.addEventListener("close", () => {
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("keydown", onKey);
      form.querySelector("[data-close]").removeEventListener("click", onCloseClick);
      resolve(result);
    }, { once: true });
    d.showModal();
    (form.querySelector('input[name="burdenPercent"]:checked') ?? form.querySelector('input[name="burdenPercent"]:not(:disabled)')).focus();
  });
}
