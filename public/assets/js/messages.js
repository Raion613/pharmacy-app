// つながる薬局：患者と薬局の LINE でのやり取り（ファーマシフト社の「つながる薬局」を想定）。
// kusudamaクラウド薬歴では、このやり取りを薬歴の作成に使える。このアプリでも、届いたメッセージは指導記録を書く画面に出て、S に写せる。
// 実際のサービスとはつないでいないので、受信は左下の「デモ」から行う。返信は保存するだけで、どこにも送らない。
import { renderShell, api, ApiError, escapeHtml, formatDateTime, toast, debounce, listNavigator } from "./app.js";
import { setTour, autoStartTour } from "./tour.js";

renderShell({ page: "messages", title: "つながる薬局", crumbs: [{ label: "つながる薬局" }] });

const $ = (s) => document.querySelector(s);
let threads = [];
let current = null; // 選んでいる患者の ID

async function loadThreads() {
  threads = await api("/api/line");
  $("#thread-count").textContent = `${threads.length}人`;
  $("#threads").innerHTML = threads.length ? threads.map((t) => `
    <li data-patient="${t.patientId}" aria-selected="${t.patientId === current}">
      <div class="th-head"><b>${escapeHtml(t.patient.name)}</b><span class="sub">${escapeHtml(t.patient.patientNo)}</span><span class="time">${formatDateTime(t.sentAt).slice(5, 16)}</span></div>
      <div class="th-last ${t.direction === "in" ? "in" : ""}">${t.direction === "in" ? "" : "薬局："}${escapeHtml(t.body)}</div>
    </li>`).join("") : '<li class="none">まだやり取りはありません</li>';
}

async function openThread(patientId) {
  current = patientId;
  const list = await api(`/api/line/${patientId}`);
  const name = threads.find((t) => t.patientId === patientId)?.patient.name ?? list[0]?.patient.name;
  $("#chat-head").innerHTML = `${escapeHtml(name)}<span class="spacer"></span><a class="btn btn-small" href="/patient?id=${patientId}">薬歴を開く</a>`;
  $("#chat-log").innerHTML = list.map((m) => `<li class="msg ${m.direction}"><div class="bubble">${escapeHtml(m.body).replaceAll("\n", "<br>")}</div>
    <span class="meta">${formatDateTime(m.sentAt)}${m.direction === "out" ? `・${escapeHtml(m.by)}` : ""}</span></li>`).join("");
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  $("#reply-form").hidden = false;
  for (const li of document.querySelectorAll("#threads li[data-patient]")) li.setAttribute("aria-selected", String(Number(li.dataset.patient) === patientId));
}

const nav = listNavigator({ container: $("#threads"), rowSelector: "li[data-patient]", onOpen: (li) => openThread(Number(li.dataset.patient)) });
$("#threads").addEventListener("keydown", (e) => nav.handleKey(e));
$("#threads").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-patient]");
  if (li) openThread(Number(li.dataset.patient));
});

$("#reply-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/line/reply", { method: "POST", body: { patientId: current, body: $("#reply-body").value } });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 422) throw err;
    toast(err.details[0].message, "error");
    return;
  }
  $("#reply-body").value = "";
  await loadThreads();
  await openThread(current);
  $("#reply-body").focus();
});
$("#reply-body").addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    $("#reply-form").requestSubmit();
  }
});

// ---------- デモ：受信 ----------

const search = debounce(async () => {
  const list = await api(`/api/patients?q=${encodeURIComponent($("#receive-q").value.trim())}`);
  $("#receive-patient").innerHTML = list.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}（${escapeHtml(p.patientNo)}）</option>`).join("");
  $("#receive-patient").selectedIndex = 0;
}, 200);
$("#receive-q").addEventListener("input", search);
$("#receive-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#receive-error").textContent = "";
  const patientId = $("#receive-patient").value === "" ? null : Number($("#receive-patient").value);
  try {
    await api("/api/line/receive", { method: "POST", body: { patientId, body: $("#receive-body").value } });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 422) throw err;
    $("#receive-error").textContent = err.details.map((d) => d.message).join("／");
    return;
  }
  $("#receive-body").value = "";
  await loadThreads();
  await openThread(patientId);
  toast("メッセージを受信しました（デモ）");
});

await loadThreads();
const want = new URLSearchParams(location.search).get("patient");
if (want) await openThread(Number(want));
else if (threads.length) await openThread(threads[0].patientId);
search();

setTour("messages", [
  {
    title: "つながる薬局：患者との LINE のやり取り",
    body: `<p>「つながる薬局」（ファーマシフト社が提供する、薬局の LINE 公式アカウントのサービス）で患者さんとやり取りした内容を見る画面です。kusudamaクラウド薬歴は、このやり取りを薬歴の作成に使えます。</p>
      <p>このアプリは実際のサービスとはつないでいません。受信は左下の<strong>デモ</strong>から行い、返信は保存するだけです。</p>`,
  },
  {
    target: ".threads",
    placement: "right",
    title: "やり取りのある患者",
    body: "<p>最新のメッセージが新しい患者が上です。<kbd>↑</kbd><kbd>↓</kbd> と <kbd>Enter</kbd> で開きます。</p>",
  },
  {
    target: ".chat",
    placement: "left",
    title: "やり取りと返信",
    body: `<p>左が患者さん、右が薬局です。<kbd>Ctrl</kbd>+<kbd>Enter</kbd> で返信します。</p>
      <p>患者さんから届いたメッセージは、次の来局で<strong>指導記録を書く画面の右側</strong>に出て、「S に写す」で記録に使えます。</p>`,
  },
]);
autoStartTour();
