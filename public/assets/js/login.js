import { api, ApiError } from "./app.js";
import { setTour, startTour, autoStartTour, tourActive } from "./tour.js";
import { icon } from "./icons.js";

const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (tourActive()) return;
  error.hidden = true;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const r = await api("/api/login", { method: "POST", body: { loginId: form.loginId.value.trim(), password: form.password.value } });
    if (r.mfa) {
      // パスワードは合った。多要素認証を設定した人には、続けて認証アプリの6桁を求める
      form.hidden = true;
      mfaForm.hidden = false;
      mfaForm.code.focus();
      return;
    }
    goNext();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    error.textContent = err.message;
    error.hidden = false;
    form.password.select();
    button.disabled = false;
  }
});

// 別サイトへ飛ばされないよう、戻り先は自サイト内のパスだけを受け付ける
function goNext() {
  const next = new URLSearchParams(location.search).get("next");
  location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/patients";
}

const mfaForm = document.querySelector("#mfa-form");
const mfaError = document.querySelector("#mfa-error");
mfaForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  mfaError.hidden = true;
  try {
    await api("/api/login/mfa", { method: "POST", body: { code: mfaForm.code.value.trim() } });
    goNext();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    mfaError.textContent = err.message;
    mfaError.hidden = false;
    mfaForm.code.select();
  }
});

document.querySelector("#fill-demo").addEventListener("click", () => {
  form.loginId.value = "demo";
  form.password.value = "pharmacy-demo";
  form.querySelector("button[type=submit]").focus();
});

const tourButton = document.querySelector("#tour-button");
tourButton.insertAdjacentHTML("afterbegin", icon("help", 14));
tourButton.addEventListener("click", startTour);

setTour("login", [
  {
    title: "薬剤料計算・薬歴へようこそ",
    body: `<p>調剤薬局の業務のうち、<strong>薬価改定に追従する薬剤料の計算</strong>と<strong>患者の薬歴</strong>を扱う小さな Web アプリです。</p>
      <ul>
        <li>薬価は、レセプト請求に使う支払基金の「医薬品マスター」の実データです</li>
        <li>同じ処方でも、調剤日が改定の前か後かで使う薬価が変わります。年度の途中で変わる薬価・廃止・長期収載品の選定療養も、マスターの日付どおりに反映します</li>
        <li>患者・メモ・指導記録はすべて架空のデモデータです</li>
      </ul>`,
  },
  {
    target: ".demo-note",
    title: "デモ用アカウント",
    body: "<p>ログインID <code>demo</code>、パスワード <code>pharmacy-demo</code> で入れます。<strong>「入力欄に入れる」</strong>を押すと、両方の欄に入ります。</p>",
  },
  {
    target: "#login-form",
    title: "ログイン",
    body: `<p>ログインすると患者一覧に移ります。</p>
      <p>ログインしていない間は、患者の情報は一切表示されません（サーバーが返しません）。</p>`,
  },
]);
autoStartTour();
