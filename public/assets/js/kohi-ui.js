// 公費（受給者証）の窓。患者の帯の「公費」から開き、登録されている受給者証を見て、新しい受給者証を足す。
import { api, ApiError, escapeHtml, formatDate, today } from "./app.js";
import { KOHI_KINDS, LOCAL_FORMS, kohiName, kohiValidOn, kohiBurdenText } from "./kohi.js";

let dialog = null;
function ensureDialog() {
  if (dialog) return dialog;
  document.body.insertAdjacentHTML("beforeend", `
    <dialog id="kohi-dialog" class="wide" aria-labelledby="kohi-title">
      <form id="kohi-form" novalidate>
        <div class="panel-head" id="kohi-title">公費（受給者証）</div>
        <div class="dialog-body">
          <table class="grid kohi-list"><thead><tr><th>公費</th><th>公費負担者番号</th><th>受給者番号</th><th>有効期間</th><th>患者の負担</th></tr></thead><tbody></tbody></table>
          <p class="empty" id="kohi-none">登録されている受給者証はありません。</p>
          <h3 class="kohi-add-head">受給者証を足す</h3>
          <div class="kohi-add">
            <div class="field"><label for="k-kind">公費</label>
              <select class="input" id="k-kind" name="kind">${Object.entries(KOHI_KINDS).map(([v, k]) => `<option value="${v}">${escapeHtml(k.label)}${k.law ? `（法別${k.law}）` : ""}</option>`).join("")}</select>
              <span class="error-text" data-error="kind"></span></div>
            <div class="field" data-local><label for="k-local-name">助成の名前</label><input class="input" id="k-local-name" name="localName" placeholder="例：子ども医療費助成（上田市）" autocomplete="off"><span class="error-text" data-error="localName"></span></div>
            <div class="field"><label for="k-payer">公費負担者番号（8桁）</label><input class="input num" id="k-payer" name="payerNo" inputmode="numeric" maxlength="8" autocomplete="off"><span class="error-text" data-error="payerNo"></span></div>
            <div class="field"><label for="k-recipient">受給者番号</label><input class="input num" id="k-recipient" name="recipientNo" inputmode="numeric" maxlength="16" autocomplete="off"><span class="error-text" data-error="recipientNo"></span></div>
            <div class="field"><label for="k-from">有効期間</label><div class="kohi-dates"><input class="input" type="date" max="9999-12-31" id="k-from" name="validFrom">〜<input class="input" type="date" max="9999-12-31" id="k-until" name="validUntil" aria-label="有効期間の終わり"></div>
              <span class="error-text" data-error="validFrom"></span><span class="error-text" data-error="validUntil"></span></div>
            <div class="field" data-local><span class="label">薬局での負担</span><div class="radio-row" role="radiogroup">${Object.entries(LOCAL_FORMS).map(([v, l]) => `<label><input type="radio" name="localForm" value="${v}">${l}</label>`).join("")}</div>
              <span class="error-text" data-error="localForm"></span></div>
            <div class="field" data-per-visit><label for="k-per-visit">1回の額（円）</label><input class="input num" id="k-per-visit" name="perVisitYen" inputmode="numeric" autocomplete="off"><span class="error-text" data-error="perVisitYen"></span></div>
            <div class="field" data-cap><label for="k-cap">自己負担の上限月額（円）</label><input class="input num" id="k-cap" name="capYen" inputmode="numeric" autocomplete="off" placeholder="上限なしなら空"><span class="error-text" data-error="capYen"></span></div>
          </div>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" data-close>閉じる <kbd>Esc</kbd></button>
          <button type="submit" class="btn btn-primary">受給者証を足す <kbd>Ctrl+Enter</kbd></button>
        </div>
      </form>
    </dialog>`);
  dialog = document.querySelector("#kohi-dialog");
  return dialog;
}

// 公費の窓を開く。足したら新しい公費の一覧、何も足さずに閉じたら null を返す
export function openKohiDialog(patient) {
  const d = ensureDialog();
  const form = d.querySelector("form");
  let list = patient.kohi;
  let changed = false;
  const renderList = () => {
    d.querySelector(".kohi-list tbody").innerHTML = list.map((k) => `<tr class="${kohiValidOn(k, today()) ? "" : "expired"}">
      <td>${escapeHtml(kohiName(k))}</td><td class="num">${escapeHtml(k.payerNo)}</td><td class="num">${escapeHtml(k.recipientNo)}</td>
      <td>${formatDate(k.validFrom)}〜${formatDate(k.validUntil)}</td><td>${kohiBurdenText(k)}</td></tr>`).join("");
    d.querySelector(".kohi-list").hidden = list.length === 0;
    d.querySelector("#kohi-none").hidden = list.length > 0;
  };
  const sync = () => {
    const local = form.elements.kind.value === "local";
    const localForm = form.querySelector('input[name="localForm"]:checked')?.value;
    for (const el of d.querySelectorAll("[data-local]")) el.hidden = !local;
    d.querySelector("[data-per-visit]").hidden = !(local && localForm === "perVisit");
    d.querySelector("[data-cap]").hidden = local && localForm !== "cap";
  };
  form.reset();
  for (const el of form.querySelectorAll("[data-error]")) el.textContent = "";
  renderList();
  sync();

  return new Promise((resolve) => {
    const num = (v) => (v.trim() === "" ? null : Number(v.trim()));
    const onSubmit = async (e) => {
      e.preventDefault();
      for (const el of form.querySelectorAll("[data-error]")) el.textContent = "";
      const f = form.elements;
      const body = {
        kind: f.kind.value, payerNo: f.payerNo.value, recipientNo: f.recipientNo.value, validFrom: f.validFrom.value || null, validUntil: f.validUntil.value || null,
        localName: f.localName.value, localForm: form.querySelector('input[name="localForm"]:checked')?.value ?? null,
        perVisitYen: num(f.perVisitYen.value), capYen: num(f.capYen.value),
      };
      let added;
      try {
        added = await api(`/api/patients/${patient.id}/kohi`, { method: "POST", body });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 422) throw err;
        for (const x of err.details) form.querySelector(`[data-error="${x.path}"]`).textContent = x.message;
        form.querySelector(`[name="${err.details[0].path}"]`).focus();
        return;
      }
      list = [added, ...list];
      changed = true;
      form.reset();
      sync();
      renderList();
      f.kind.focus();
    };
    const onKey = (e) => {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        form.requestSubmit();
      }
    };
    const onClose = () => d.close();
    form.addEventListener("submit", onSubmit);
    form.addEventListener("keydown", onKey);
    form.addEventListener("change", sync);
    form.querySelector("[data-close]").addEventListener("click", onClose);
    d.addEventListener("close", () => {
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("keydown", onKey);
      form.removeEventListener("change", sync);
      form.querySelector("[data-close]").removeEventListener("click", onClose);
      resolve(changed ? list : null);
    }, { once: true });
    d.showModal();
    form.elements.kind.focus();
  });
}
