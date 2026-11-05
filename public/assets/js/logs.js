import { renderShell, api, escapeHtml, formatDateTime } from "./app.js";
import { setTour, autoStartTour } from "./tour.js";

const patientId = new URLSearchParams(location.search).get("patient");
renderShell({ page: "logs", title: "閲覧記録", crumbs: [{ label: "閲覧記録" }] });

const ACTIONS = {
  login: ["ログイン", ""],
  logout: ["ログアウト", ""],
  "patient.view": ["患者情報を表示", "act-view"],
  "patient.create": ["患者を登録", "act-create"],
  "prescription.create": ["処方を保存", "act-create"],
  "note.create": ["患者メモを追加", "act-create"],
  "record.create": ["指導記録を記載", "act-create"],
  "master.import": ["医薬品マスターを取り込み", "act-create"],
  "measurement.create": ["検査値を入力", "act-create"],
  "conversation.create": ["服薬指導を文字起こし", "act-create"],
  "tracing.create": ["トレーシングレポートを作成", "act-create"],
  "homecare.register": ["在宅の患者を登録", "act-create"],
  "homecare.plan": ["在宅の計画書を作成", "act-create"],
  "homecare.schedule": ["訪問を予定", "act-create"],
  "homecare.visit": ["訪問を記録", "act-create"],
  "reception.create": ["処方箋を受付", "act-create"],
  "reception.step": ["業務を進めた", "act-create"],
  "inspection.create": ["調剤監査を保存", "act-create"],
  "line.receive": ["つながる薬局で受信", "act-create"],
  "line.reply": ["つながる薬局で返信", "act-create"],
  "mfa.enable": ["多要素認証を有効にした", ""],
  "mfa.disable": ["多要素認証を無効にした", ""],
};

const logs = await api(`/api/access-logs${patientId ? `?patient=${patientId}` : ""}`);
if (patientId) {
  const name = logs.find((l) => l.patient)?.patient.name;
  document.querySelector("#title").textContent = name ? `閲覧記録：${name}` : "閲覧記録（この患者）";
  document.querySelector("#clear").hidden = false;
}
document.querySelector("#count").textContent = `新しい順に ${logs.length}件${logs.length === 300 ? "（直近300件）" : ""}`;
document.querySelector("#empty").hidden = logs.length > 0;
document.querySelector("#rows").innerHTML = logs.map((l) => {
  const [label, cls] = ACTIONS[l.action];
  const patient = l.patient
    ? `<a href="/patient?id=${l.patient.id}">${escapeHtml(l.patient.name)}</a> <span class="sub">${escapeHtml(l.patient.patientNo)}</span>`
    : "";
  return `<tr>
    <td class="num">${formatDateTime(l.at)}</td>
    <td>${escapeHtml(l.userName)} <span class="sub">${escapeHtml(l.loginId)}</span></td>
    <td class="act ${cls}">${label}</td>
    <td>${patient}</td>
    <td>${l.detail ? escapeHtml(l.detail) : ""}</td>
  </tr>`;
}).join("");

setTour("logs", [
  {
    title: "閲覧記録：誰が・いつ・どの患者を",
    body: `<p>患者の情報を開いた・書いた操作の記録（アクセスログ）です。医療情報は、見た人と時刻を後から追えることが求められます。</p>
      <p>記録は、患者の情報を返すたびに<strong>サーバーが残します</strong>。画面から消すことはできません。</p>`,
  },
  {
    target: ".logs .grid thead",
    title: "記録の中身",
    body: `<ul>
        <li><b>日時・利用者</b>：誰の操作か</li>
        <li><b>操作</b>：患者情報の表示（青）、登録・保存・記載（緑）、ログイン・ログアウト</li>
        <li><b>患者</b>：対象の患者。名前から薬歴へ移れます</li>
        <li><b>内容</b>：どの画面で開いたか、何点の処方か など</li>
      </ul>`,
  },
  {
    title: "患者ごとに絞るには",
    body: "<p>患者の薬歴の画面で、下の<strong>「閲覧記録」</strong>を押すと、その患者の記録だけに絞って開きます。</p>",
  },
]);
autoStartTour();
