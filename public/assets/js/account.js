// アカウント：多要素認証（パスワードに加えて、スマホの認証アプリの6桁の数字で本人を確かめる）の設定。
//   有効にする：「設定を始める」→ 出てきた QR コードを認証アプリで読む → アプリに出る6桁を入れる
//   無効にする：今の6桁を入れる
// 6桁の計算は RFC 6238（TOTP）。サーバー側は src/server/totp.js。
import { renderShell, api, ApiError, escapeHtml, toast } from "./app.js";
import { encodeQr, qrSvg } from "./qr.js";
import { icon } from "./icons.js";
import { setTour, autoStartTour } from "./tour.js";

// 画面を開くたびに router.js が呼ぶ（画面は中身だけを差し替えるので、画面の処理はこの関数の中に置く）
export default async function mount() {
  renderShell({ page: "account", title: "アカウント", crumbs: [{ label: "アカウント" }] });

  const body = document.querySelector("#mfa-body");
  const state = document.querySelector("#mfa-state");

  function render({ enabled }, setup = null) {
    state.textContent = enabled ? "有効" : "未設定";
    state.className = `tag ${enabled ? "tag-generic" : ""}`;
    if (enabled) {
      body.innerHTML = `<p>${icon("shield", 18)}ログインのとき、パスワードの後に<strong>認証アプリの6桁</strong>を求めます。パスワードが漏れても、スマホが無ければ入れません。</p>
      <form id="disable-form" class="code-form" novalidate>
        <label for="code">無効にするには、今の6桁を入れてください</label>
        <input class="input code-input" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
        <button type="submit" class="btn">無効にする</button>
        <span class="error-text" id="code-error"></span>
      </form>`;
      bind("#disable-form", "disable", "多要素認証を無効にしました");
      return;
    }
    if (setup) {
      const qr = qrSvg(encodeQr(new TextEncoder().encode(setup.uri)), 4);
      body.innerHTML = `<ol class="setup-steps">
        <li>スマホの認証アプリ（Google Authenticator・Microsoft Authenticator など）で、この QR コードを読みます。
          <div class="qr">${qr}</div>
          <p class="hint">読めないときは、キーを手で入れます：<code class="secret">${escapeHtml(setup.secret.replace(/(.{4})/g, "$1 ").trim())}</code>（時間ベース・6桁・30秒）</p></li>
        <li>アプリに出ている6桁を入れて、有効にします。
          <form id="confirm-form" class="code-form" novalidate>
            <input class="input code-input" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="認証アプリの6桁">
            <button type="submit" class="btn btn-primary">有効にする</button>
            <span class="error-text" id="code-error"></span>
          </form></li>
      </ol>`;
      bind("#confirm-form", "confirm", "多要素認証を有効にしました。次のログインから6桁を求めます");
      return;
    }
    body.innerHTML = `<p>パスワードだけでなく、スマホの認証アプリが30秒ごとに出す<strong>6桁の数字</strong>でも本人を確かめます。患者の情報を扱うので、パスワードが漏れたときの備えになります。</p>
    <button type="button" class="btn btn-primary" id="begin">設定を始める</button>`;
    document.querySelector("#begin").addEventListener("click", async () => {
      render({ enabled: false }, await api("/api/account/mfa", { method: "POST", body: { action: "begin" } }));
      document.querySelector("#code").focus();
    });
  }

  function bind(selector, action, done) {
    document.querySelector(selector).addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const status = await api("/api/account/mfa", { method: "POST", body: { action, code: document.querySelector("#code").value.trim() } });
        render(status);
        toast(done);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 422) throw err;
        document.querySelector("#code-error").textContent = err.details[0]?.message ?? err.message;
        document.querySelector("#code").select();
      }
    });
  }

  render(await api("/api/account/mfa"));

  setTour("account", [
    {
      target: ".account-panel",
      title: "多要素認証",
      body: `<p>ログインを<strong>パスワード（知っているもの）＋ スマホ（持っているもの）</strong>の2つで確かめる設定です。</p>
      <p>スマホの認証アプリとサーバーが同じ「秘密」を持ち、今の時刻から同じ6桁を計算します（RFC 6238 の TOTP）。数字が合えば、そのスマホを持っている本人だと分かります。同じ6桁は2回使えません。</p>`,
    },
  ]);
  autoStartTour();
}
