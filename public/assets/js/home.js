import { renderShell, api, escapeHtml, toast, refreshUnreadDot, ApiError } from "./app.js";
import { setTour, autoStartTour } from "./tour.js";
import { icon } from "./icons.js";

// 回覧板：本部からの伝達・日報月報・広報と、薬局の中の申し送り・報告・連絡・相談。新しい投稿が上。
// 読んだら「確認した」を押す（紙の回覧板の判子）。誰が確認したかが全員に見える。追記だけで、直さない・消さない
const KINDS = {
  hq: { label: "本部から", tone: "hq" },
  periodic: { label: "日報・月報", tone: "hq" },
  pr: { label: "広報", tone: "pr" },
  handover: { label: "申し送り", tone: "handover" },
  report: { label: "報告", tone: "report" },
  contact: { label: "連絡", tone: "contact" },
  consult: { label: "相談", tone: "consult" },
};
const POSTABLE = ["handover", "report", "contact", "consult"];

// 名前から決まる、やわらかい色（同じ人はいつも同じ色）
const HUES = [205, 160, 28, 280, 340, 95, 230];
function hueOf(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
const initial = (name) => [...name][0];
const firstName = (name) => name.split(/\s/)[0];
function avatar(name, hq, attrs = "") {
  return hq
    ? `<div class="avatar hq" aria-hidden="true" ${attrs}>本</div>`
    : `<div class="avatar" style="--hue:${hueOf(name)}" aria-hidden="true" ${attrs}>${escapeHtml(initial(name))}</div>`;
}

// 「3分前」「昨日 18:10」「11/4」のように、今からの近さで書く
function ago(iso) {
  const t = new Date(iso);
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  if (min < 60 * 6) return `${Math.floor(min / 60)}時間前`;
  const hm = `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(t)) / 86400000);
  if (days === 0) return `今日 ${hm}`;
  if (days === 1) return `昨日 ${hm}`;
  return `${t.getMonth() + 1}/${t.getDate()}`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? "おはようございます" : h < 17 ? "おつかれさまです" : "今日もおつかれさまでした";
}

// 画面を開くたびに router.js が呼ぶ
export default async function mount() {
  renderShell({ page: "home", title: "回覧板", crumbs: [{ label: "回覧板" }] });

  const feed = document.querySelector("#feed");
  const form = document.querySelector("#compose");
  const bodyEl = document.querySelector("#compose-body");
  const postBtn = document.querySelector("#compose-post");
  const countEl = document.querySelector("#compose-count");
  const errorEl = document.querySelector("#compose-error");
  let kind = "handover";

  const [me, first] = await Promise.all([api("/api/me"), api("/api/notices")]);
  let state = first;

  const now = new Date();
  document.querySelector("#hello-date").textContent = `${now.getMonth() + 1}月${now.getDate()}日（${"日月火水木金土"[now.getDay()]}）`;
  document.querySelector("#hello-title").textContent = `${greeting()}、${firstName(me.displayName)}さん`;
  document.querySelector("#compose-avatar").outerHTML = avatar(me.displayName, false, 'id="compose-avatar"');

  // 種類：申し送り・報告・連絡・相談（ほうれんそう）。←→で選べる
  const kindsEl = document.querySelector("#compose-kinds");
  kindsEl.innerHTML = POSTABLE.map((k) =>
    `<button type="button" role="radio" class="kind-chip tone-${KINDS[k].tone}" data-kind="${k}" aria-checked="${k === kind}" tabindex="${k === kind ? 0 : -1}">${KINDS[k].label}</button>`).join("");
  function pickKind(k, focus) {
    kind = k;
    for (const b of kindsEl.querySelectorAll("[data-kind]")) {
      const on = b.dataset.kind === k;
      b.setAttribute("aria-checked", on);
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
  }
  kindsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (b) pickKind(b.dataset.kind, false);
  });
  kindsEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = POSTABLE.indexOf(kind) + (e.key === "ArrowRight" ? 1 : -1);
    pickKind(POSTABLE[(i + POSTABLE.length) % POSTABLE.length], true);
  });

  // 書いている間だけ入力欄を広げる
  function syncCompose() {
    postBtn.disabled = bodyEl.value.trim() === "";
    countEl.textContent = bodyEl.value.length > 800 ? `${bodyEl.value.length} / 1000` : "";
    form.classList.toggle("writing", document.activeElement === bodyEl || bodyEl.value !== "");
    errorEl.hidden = true;
  }
  bodyEl.addEventListener("input", syncCompose);
  bodyEl.addEventListener("focus", syncCompose);
  bodyEl.addEventListener("blur", syncCompose);
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (postBtn.disabled) return;
    postBtn.disabled = true;
    try {
      const { id } = await api("/api/notices", { method: "POST", body: { kind, body: bodyEl.value } });
      state = await api("/api/notices");
      bodyEl.value = "";
      bodyEl.blur();
      syncCompose();
      render(id);
      toast(`${KINDS[kind].label}を回覧しました`);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 422) throw err;
      errorEl.textContent = err.details.map((d) => d.message).join("　");
      errorEl.hidden = false;
      postBtn.disabled = false;
    }
  });

  // 確認した：その場で判子を押した形に変え、裏で保存する
  feed.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-read]");
    if (!btn) return;
    const n = state.notices.find((x) => x.id === Number(btn.dataset.read));
    n.read = true;
    n.readBy = [...n.readBy, me.displayName];
    btn.closest(".post").outerHTML = post(n, "stamped");
    feed.querySelector(`[data-id="${n.id}"] .read-btn`).focus();
    renderHello();
    await api(`/api/notices/${n.id}/read`, { method: "POST", body: {} });
    refreshUnreadDot();
  });

  function readers(n) {
    if (n.readBy.length === 0) return `<span class="readers none">まだだれも確認していません</span>`;
    const faces = n.readBy.slice(0, 4).map((name) => `<span class="mini" style="--hue:${hueOf(name)}">${escapeHtml(initial(name))}</span>`).join("");
    const names = n.readBy.map(firstName);
    const text = names.length <= 2 ? `${names.join("・")}が確認` : `${names[0]}ほか${names.length - 1}人が確認`;
    return `<span class="readers" title="確認した人：${escapeHtml(n.readBy.join("、"))}"><span class="faces">${faces}</span>${escapeHtml(text)}<span class="of">${n.readBy.length}/${state.staff}</span></span>`;
  }

  function post(n, anim = "") {
    const k = KINDS[n.kind];
    // 確認済みのボタンは押せないが、フォーカスは残す（押した直後にカーソルが迷子にならないように）
    const action = n.read
      ? `<button type="button" class="read-btn done" aria-disabled="true" tabindex="-1">${icon("check", 15)}確認済み</button>`
      : `<button type="button" class="read-btn" data-read="${n.id}" title="読んだら押す（紙の回覧板の判子）">${icon("check", 15)}確認した</button>`;
    return `<li class="post ${n.read ? "" : "unread"} ${anim}" data-id="${n.id}">
      ${avatar(n.author, n.fromHq)}
      <article class="post-main">
        <header class="post-head">
          <span class="who">${escapeHtml(n.author)}</span>
          <span class="kind-tag tone-${k.tone}">${k.label}</span>
          <time datetime="${n.createdAt}" title="${new Date(n.createdAt).toLocaleString("ja-JP")}">${ago(n.createdAt)}</time>
          ${n.read ? "" : '<span class="new-dot" title="まだ確認していません"></span>'}
        </header>
        <p class="post-body">${escapeHtml(n.body)}</p>
        <footer class="post-foot">${readers(n)}<span class="spacer"></span>${action}</footer>
      </article>
    </li>`;
  }

  function renderHello() {
    const unread = state.notices.filter((n) => !n.read).length;
    document.querySelector("#hello-sub").textContent = unread === 0
      ? "回覧はぜんぶ確認済みです"
      : `まだ確認していない回覧が ${unread}件あります`;
  }

  function render(newId) {
    feed.innerHTML = state.notices.length === 0
      ? `<li class="feed-empty">まだ投稿はありません</li>`
      : state.notices.map((n) => post(n, n.id === newId ? "arrive" : "")).join("");
    renderHello();
  }
  render();

  setTour("home", [
    {
      title: "回覧板：薬局の中の伝達",
      body: `<p>本部からのお知らせ・日報月報・広報と、薬局の中の<strong>申し送り・報告・連絡・相談</strong>が、新しい順に並びます。</p>
      <p>左上の<strong>「薬」</strong>を押すと、どの画面からでもここに戻れます。まだ確認していない回覧があると、赤い点が付きます。</p>`,
    },
    {
      target: "#compose",
      title: "書く",
      body: `<p>種類（申し送り・報告・連絡・相談）を選んで書き、<strong>投稿</strong>（Ctrl+Enter）。午前と午後で人が替わる日の申し送りにも使います。</p>
      <p>患者のことは書きません。患者ごとの続きは、その患者の薬歴の申し送りへ書きます。</p>`,
    },
    {
      target: "#feed",
      title: "読んだら「確認した」",
      body: `<p>紙の回覧板の判子と同じです。押すと、誰が確認したかが全員に見えます（右の数字は 確認した人 / 薬局の人数）。</p>
      <p>投稿は直したり消したりできません（伝えたことの記録を残すため）。</p>`,
    },
  ]);
  autoStartTour();
}
