// 負担割合の窓。患者の欄の「負担割合」から開いて変える／受付・処方入力のときに、割合が変わりうる日を過ぎていたら自動で開く。
import { api, ApiError, escapeHtml, formatDate } from "./app.js";
import { ageParts, burdenLongText } from "./burden-text.js";

// 確認が要るか：前回確かめた日（前回の来局か、窓で確かめた日の遅い方）より後に割合が変わりうる日が来た／今の割合がその日にありえない。
// 割合の規則はサーバーだけが持つ（/api/calc/burden）。choices（その日に選べる割合）も一緒に返る
export function burdenCheck(patient, date) {
  const { birthDate, burdenPercent, burdenReason, burdenUntil, lastDispensedOn, burdenCheckedOn } = patient;
  return api("/api/calc/burden", {
    method: "POST", body: { birthDate, date, patient: { burdenPercent, burdenReason, burdenUntil, lastDispensedOn, burdenCheckedOn } },
  });
}

// 選択肢ごとの説明
function why(c) {
  if (c.reason === "disability") return "65〜74歳で障害の認定を受け、後期高齢者医療に入った人（所得で1・2・3割）";
  if (c.reason === "exempt") return "災害・急な収入の減少などで、保険者が一部負担金を免除した人（期限まで）";
  if (c.reason === "welfare") return "医療券・調剤券で来局する人";
  return { 30: "小学生〜69歳／70歳以上で現役並みの所得", 20: "小学校に上がる前／70〜74歳／75歳以上で一定以上の所得", 10: "75歳以上（後期高齢者医療）" }[c.percent];
}
const keyOf = (c) => `${c.percent}:${c.reason ?? ""}`;

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
            <div class="burden-until" id="burden-until" hidden>
              <label for="burden-until-input">免除の期限</label>
              <input class="input" type="date" max="9999-12-31" id="burden-until-input">
            </div>
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
export async function openBurdenDialog(patient, date) {
  const d = ensureDialog();
  const form = d.querySelector("form");
  const { events, problem, choices } = await burdenCheck(patient, date);
  const age = ageParts(patient.birthDate, date);
  d.querySelector("#burden-title").textContent = events.length || problem ? "負担割合の確認" : "負担割合を変える";
  d.querySelector("#burden-who").innerHTML = `<b>${escapeHtml(patient.name)}</b>さん　${formatDate(date)}時点で <b>${age.years}歳${age.months}か月</b>
    ・今の登録 <b>${burdenLongText(patient.burdenPercent, patient.burdenReason)}</b>${patient.lastDispensedOn ? `・前回の来局 ${formatDate(patient.lastDispensedOn)}` : ""}`;
  d.querySelector("#burden-events").innerHTML = events.map((e) => `<li><span class="on">${formatDate(e.on)}</span>${escapeHtml(e.text)}</li>`).join("");
  const problemEl = d.querySelector("#burden-mismatch");
  problemEl.hidden = problem === null;
  problemEl.textContent = problem ?? "";
  // 今の割合がありうるならそれ、ありえず年齢の標準が1つならそれを選んでおく（70歳以上は所得で決まるので選ばない）
  const standard = choices.filter((c) => c.reason === null);
  const current = choices.find((c) => c.percent === patient.burdenPercent && c.reason === patient.burdenReason);
  const preset = problem === null && current ? current : standard.length === 1 ? standard[0] : null;
  const radio = (c) => `<label><input type="radio" name="burden" value="${keyOf(c)}" ${preset && keyOf(c) === keyOf(preset) ? "checked" : ""}>
    <b>${burdenLongText(c.percent, c.reason)}</b><span class="why">${why(c)}</span></label>`;
  d.querySelector("#burden-choices").innerHTML = `${standard.map(radio).join("")}
    <p class="burden-group">年齢の標準から外れる事情</p>${choices.filter((c) => c.reason !== null).map(radio).join("")}`;
  const untilBox = d.querySelector("#burden-until");
  const untilInput = d.querySelector("#burden-until-input");
  untilInput.value = patient.burdenReason === "exempt" ? patient.burdenUntil : "";
  untilInput.min = date;
  const showUntil = () => {
    untilBox.hidden = form.querySelector('input[name="burden"]:checked')?.value !== "0:exempt";
  };
  showUntil();
  form.querySelector("[data-error]").textContent = "";

  return new Promise((resolve) => {
    let result = null;
    const onSubmit = async (e) => {
      e.preventDefault();
      const checked = form.querySelector('input[name="burden"]:checked');
      if (!checked) {
        form.querySelector("[data-error]").textContent = "負担割合を選んでください";
        return;
      }
      const [percent, reason] = checked.value.split(":");
      const body = { burdenPercent: Number(percent), burdenReason: reason || null, date };
      if (reason === "exempt") body.burdenUntil = untilInput.value || null;
      try {
        result = await api(`/api/patients/${patient.id}/burden`, { method: "PUT", body });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 422) throw err;
        form.querySelector("[data-error]").textContent = err.details[0].message;
        return;
      }
      d.close();
    };
    const onKey = (e) => {
      if (e.key === "Enter" && e.target.name === "burden") {
        e.preventDefault();
        if (e.target.value === "0:exempt" && untilInput.value === "") untilInput.focus();
        else form.requestSubmit();
      }
    };
    const onCloseClick = () => d.close();
    form.addEventListener("submit", onSubmit);
    form.addEventListener("keydown", onKey);
    form.addEventListener("change", showUntil);
    form.querySelector("[data-close]").addEventListener("click", onCloseClick);
    d.addEventListener("close", () => {
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("keydown", onKey);
      form.removeEventListener("change", showUntil);
      form.querySelector("[data-close]").removeEventListener("click", onCloseClick);
      resolve(result);
    }, { once: true });
    d.showModal();
    (form.querySelector('input[name="burden"]:checked') ?? form.querySelector('input[name="burden"]')).focus();
  });
}
