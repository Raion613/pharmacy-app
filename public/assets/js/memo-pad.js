// メモ帳（患者ごとの自由なメモ）を書くダイアログ。薬歴・処方入力など、患者を開いている画面から同じものを開く。
// 保存するとサーバーは新しい行を足す（前の内容は消えない）。画面には最新の内容だけを出す
import { api, ApiError, escapeHtml, formatDateTime, toast } from "./app.js";

const MAX = 2000;

export function memoText(memo) {
  return memo.body === "" ? '<span class="none">まだ何も書かれていません</span>' : escapeHtml(memo.body);
}
export function memoMeta(memo) {
  return memo.updatedAt === null ? "" : `${formatDateTime(memo.updatedAt)} ${memo.updatedBy}`;
}

export function setupMemoPad({ patientId, memo, onSaved }) {
  let current = memo;
  const dialog = document.createElement("dialog");
  dialog.className = "wide memo-dialog";
  dialog.setAttribute("aria-labelledby", "memo-dialog-title");
  dialog.innerHTML = `
    <form novalidate>
      <div class="panel-head" id="memo-dialog-title">メモ帳</div>
      <div class="dialog-body">
        <textarea class="input textarea" name="body" rows="12" maxlength="${MAX}" aria-label="メモ帳の内容"></textarea>
        <span class="hint counter"></span>
        <span class="error-text"></span>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" data-close>キャンセル <kbd>Esc</kbd></button>
        <button type="submit" class="btn btn-primary">保存 <kbd>Ctrl+Enter</kbd></button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  const body = form.elements.body;
  const counter = form.querySelector(".counter");
  const error = form.querySelector(".error-text");
  const count = () => { counter.textContent = `${body.value.length} / ${MAX}文字`; };
  body.addEventListener("input", count);
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  form.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation(); // 画面側の Ctrl+Enter（処方の保存など）を動かさない
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    try {
      current = await api(`/api/patients/${patientId}/memo`, { method: "PUT", body: { body: body.value } });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 422) throw err;
      error.textContent = err.details[0].message;
      return;
    }
    dialog.close();
    onSaved(current);
    toast("メモ帳を保存しました");
  });

  return {
    open() {
      body.value = current.body;
      count();
      error.textContent = "";
      dialog.showModal();
      body.focus();
    },
  };
}
