import { ageParts } from "./burden-text.js";
import { renderShell, leave, api, ApiError, escapeHtml, formatDate, birthText, SEX, debounce, listNavigator, toastNext, today } from "./app.js";
import { icon } from "./icons.js";
import { NOTE_LABEL } from "./record-kinds.js";
import { setTour, autoStartTour, tourActive } from "./tour.js";

// 画面を開くたびに router.js が呼ぶ（画面は中身だけを差し替えるので、画面の処理はこの関数の中に置く）
export default async function mount() {
  renderShell({ page: "patients", title: "患者一覧", crumbs: [{ label: "患者一覧" }] });

  const q = document.querySelector("#q");
  const tbody = document.querySelector("#patients tbody");
  const scroll = document.querySelector(".results-scroll");
  const dialog = document.querySelector("#patient-dialog");
  const form = document.querySelector("#patient-form");
  document.querySelector("#q-icon").insertAdjacentHTML("afterbegin", icon("search", 16));
  document.querySelector("#new-patient").innerHTML = `${icon("userPlus", 16)}新規患者登録`;

  const openPatient = (id) => leave(`/patient?id=${id}`);
  const nav = listNavigator({ container: tbody, rowSelector: "tr", onOpen: (row) => openPatient(row.dataset.id) });

  let requestNo = 0;
  async function search() {
    const mine = ++requestNo;
    const text = q.value.trim();
    const patients = await api(`/api/patients?q=${encodeURIComponent(text)}`);
    if (mine !== requestNo) return; // 打っている途中の古い結果は捨てる
    document.querySelector("#result-title").textContent = text ? "検索結果" : "最近来局した患者";
    document.querySelector("#result-count").textContent = `${patients.length}件${patients.length === 50 ? "（先頭50件）" : ""}`;
    document.querySelector("#no-result").hidden = patients.length > 0;
    const frag = document.createDocumentFragment();
    for (const p of patients) {
      const tr = document.createElement("tr");
      tr.dataset.id = p.id;
      tr.dataset.href = `/patient?id=${p.id}`; // 押した瞬間に router.js が先に読み込む
      tr.innerHTML = `
      <td class="num">${escapeHtml(p.patientNo)}</td>
      <td><span class="kana">${escapeHtml(p.kana)}</span><span class="name">${escapeHtml(p.name)}</span></td>
      <td>${birthText(p.birthDate).replace("（", "<wbr>（")}</td>
      <td class="sex-${p.sex}">${SEX[p.sex]}</td>
      <td>${p.alertCategories.map((c) => `<span class="tag tag-ng">${NOTE_LABEL[c]}</span>`).join(" ")}</td>
      <td class="num">${p.lastDispensedOn ? formatDate(p.lastDispensedOn).replace("（", "<wbr>（") : '<span class="sub">来局なし</span>'}</td>`;
      tr.addEventListener("click", () => openPatient(p.id));
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
    nav.reset();
  }

  q.addEventListener("input", debounce(search, 200));
  q.addEventListener("keydown", (e) => {
    if (e.isComposing || tbody.rows.length === 0) return;
    if (e.key === "Enter" && tbody.rows.length === 1) {
      e.preventDefault();
      openPatient(tbody.rows[0].dataset.id);
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      scroll.focus();
      nav.select(0);
    }
  });

  // 一覧にフォーカスがある間の ↑↓ Enter。先頭で ↑ を押すと検索欄に戻る
  scroll.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && nav.index <= 0) {
      e.preventDefault();
      q.focus();
      return;
    }
    nav.handleKey(e);
  });

  document.addEventListener("keydown", (e) => {
    if (dialog.open || tourActive()) return;
    if (e.key === "/" && document.activeElement !== q) {
      e.preventDefault();
      q.focus();
      q.select();
    }
    if (e.altKey && e.code === "KeyN") {
      e.preventDefault();
      openDialog();
    }
  });

  // ---------- 新規患者登録 ----------
  function openDialog() {
    form.reset();
    showErrors([]);
    // 上限を今日にすると、ブラウザは年を4桁まで打った所で月へ進む（上限が無いと6桁まで打てる）
    form.elements.birthDate.max = today();
    limitBurdens();
    findSame();
    dialog.showModal();
    form.elements.name.focus();
  }

  // 負担割合：生年月日から、今日の年齢でありうる割合だけを選べるようにする。年齢で1つに決まるなら選んでおく
  // その年齢でありうる割合はサーバーが規則で出す（/api/calc/burden）。後から打った生年月日の結果だけを使う
  let burdenSeq = 0;
  async function limitBurdens() {
    const birth = form.elements.birthDate.value;
    const ok = birth !== "" && birth <= today();
    const seq = ++burdenSeq;
    const standard = ok ? (await api("/api/calc/burden", { method: "POST", body: { birthDate: birth, date: today() } })).standard : null;
    if (seq !== burdenSeq) return;
    const allowed = ok ? [...standard, 0] : [30, 20, 10, 0];
    for (const r of form.querySelectorAll('input[name="burdenPercent"]')) {
      r.disabled = !allowed.includes(Number(r.value));
      r.closest("label").classList.toggle("disabled", r.disabled);
      if (r.disabled) r.checked = false;
    }
    const insured = allowed.filter((p) => p !== 0);
    if (ok && insured.length === 1 && !form.querySelector('input[name="burdenPercent"][value="0"]').checked) {
      form.querySelector(`input[name="burdenPercent"][value="${insured[0]}"]`).checked = true;
    }
    const age = ok ? ageParts(birth, today()) : null;
    document.querySelector("#p-burden-hint").textContent = ok
      ? `${age.years}歳${age.months}か月。${insured.length === 1 ? `年齢の標準は${insured[0] / 10}割です` : "所得で決まります。高齢受給者証・後期高齢者医療の資格確認の割合を選んでください"}。障害認定・一部負担金の免除は、登録の後に薬歴の帯の「負担」から`
      : "生年月日を入れると、その年齢でありうる割合だけ選べます";
  }
  form.elements.birthDate.addEventListener("input", limitBurdens);

  // 登録済みの患者：氏名・カナを打つたびに、同じ文字を含む患者を出す（同じ人を二重に登録しないため）。生年月日まで同じ人を上に
  const sameBox = document.querySelector("#same-patients");
  const SAME_SHOWN = 5;
  let sameSeq = 0;
  let same = [];
  async function findSame() {
    const words = [...new Set([form.elements.kana.value.trim(), form.elements.name.value.trim()].filter((w) => w !== ""))];
    const seq = ++sameSeq;
    if (words.length === 0) {
      sameBox.hidden = true;
      return;
    }
    const lists = await Promise.all(words.map((w) => api(`/api/patients?q=${encodeURIComponent(w)}`)));
    if (seq !== sameSeq) return; // 打っている途中の古い結果は捨てる
    same = [...new Map(lists.flat().map((p) => [p.id, p])).values()];
    renderSame();
  }
  function renderSame() {
    const birth = form.elements.birthDate.value;
    const rows = same.toSorted((a, b) => (b.birthDate === birth) - (a.birthDate === birth));
    const matched = rows.filter((p) => p.birthDate === birth).length;
    document.querySelector("#same-head").innerHTML = rows.length === 0
      ? `${icon("check", 14)}<span>登録済みの患者に、この名前の人はいません</span>`
      : `<b>登録済みの患者に、名前の近い人が${rows.length}人います</b>${matched ? `<span class="tag tag-ng">生年月日も同じ ${matched}人</span>` : ""}`;
    sameBox.classList.toggle("found", rows.length > 0);
    document.querySelector("#same-list").innerHTML = rows.slice(0, SAME_SHOWN).map((p) => `
      <li class="${p.birthDate === birth ? "birth-match" : ""}">
        <span class="num">${escapeHtml(p.patientNo)}</span>
        <span><span class="kana">${escapeHtml(p.kana)}</span>${escapeHtml(p.name)}
          <span class="meta">${birthText(p.birthDate)}・${p.lastDispensedOn ? `最終来局 ${formatDate(p.lastDispensedOn)}` : "来局なし"}</span></span>
        <button type="button" class="btn btn-small" data-open="${p.id}">この人の薬歴を開く</button>
      </li>`).join("") + (rows.length > SAME_SHOWN ? `<li class="sub">ほか${rows.length - SAME_SHOWN}人（氏名・カナを続けて打つと絞れます）</li>` : "");
    sameBox.hidden = false;
  }
  const findSameSoon = debounce(findSame, 200);
  form.elements.name.addEventListener("input", findSameSoon);
  form.elements.kana.addEventListener("input", findSameSoon);
  form.elements.birthDate.addEventListener("input", () => { if (!sameBox.hidden) renderSame(); });
  sameBox.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open]");
    if (!b) return;
    dialog.close();
    openPatient(b.dataset.open);
  });

  function showErrors(details) {
    for (const el of form.querySelectorAll("[data-error]")) el.textContent = "";
    for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    for (const d of details) {
      form.querySelector(`[data-error="${d.path}"]`).textContent = d.message;
      for (const el of form.querySelectorAll(`[name="${d.path}"]`)) el.setAttribute("aria-invalid", "true");
    }
    if (details.length > 0) form.querySelector(`[name="${details[0].path}"]`).focus();
  }

  document.querySelector("#new-patient").addEventListener("click", openDialog);
  document.querySelector("#cancel-patient").addEventListener("click", () => dialog.close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const created = await api("/api/patients", {
        method: "POST",
        body: {
          name: form.elements.name.value,
          kana: form.elements.kana.value,
          birthDate: form.elements.birthDate.value,
          sex: form.elements.sex.value,
          burdenPercent: form.elements.burdenPercent.value === "" ? null : Number(form.elements.burdenPercent.value),
          burdenReason: form.elements.burdenPercent.value === "0" ? "welfare" : null, // 登録で選べる 0 は生活保護だけ（免除・障害認定は薬歴の帯から）
        },
      });
      toastNext(`患者を登録しました（患者番号 ${created.patientNo}）`);
      leave(`/patient?id=${created.id}`);
    } catch (err) {
      button.disabled = false;
      if (!(err instanceof ApiError) || err.status !== 422) throw err;
      showErrors(err.details);
    }
  });

  await search();

  setTour("patients", [
    {
      title: "患者一覧：ここから患者を開きます",
      body: `<p>来局した患者を探して、その人の薬歴を開くための画面です。業務はいつもここから始まります。</p>
      <div class="tour-map">
        <div><b>左の列</b>画面の切り替え</div>
        <div><b>検索条件</b>患者を探す・新しく登録する</div>
        <div><b>一覧</b>見つかった患者。開くと薬歴へ</div>
      </div>`,
    },
    {
      target: ".sidebar",
      placement: "right",
      title: "画面の切り替え",
      body: `<ul>
        <li><b>患者</b> <kbd>Alt</kbd>+<kbd>1</kbd>：この画面</li>
        <li><b>薬価照会</b> <kbd>Alt</kbd>+<kbd>2</kbd>：薬ごとの薬価と改定の履歴</li>
        <li><b>閲覧記録</b> <kbd>Alt</kbd>+<kbd>3</kbd>：誰がいつどの患者を開いたか</li>
      </ul>
      <p>処方入力は、患者の薬歴から開きます（患者を決めずに入力しないため）。</p>`,
    },
    {
      target: "#q",
      title: "患者を探す",
      body: `<p>患者番号・氏名・カナのどれでも探せます。カナは<strong>ひらがなのままで大丈夫</strong>です（例：「あおき」）。</p>
      <p>一覧を見ている間も、<kbd>/</kbd> でこの欄に戻れます。</p>`,
    },
    {
      target: "#patients tbody tr",
      title: "見つかった患者",
      body: `<p>何も入れていないときは、最近来局した順に並びます。</p>
      <p><strong>注意</strong>の列の赤い札は、アレルギー歴・副作用歴の記録がある患者です。</p>
      <p>行をクリックするか、<kbd>↓</kbd> で選んで <kbd>Enter</kbd> で薬歴を開きます。1件に絞れたら、検索欄で <kbd>Enter</kbd> だけで開けます。</p>
      <p>まずは<strong>青木 誠</strong>さんを開いてみてください。薬の追加・中止と、改定の前後で点数が変わる経過が入っています。</p>`,
    },
    {
      target: "#new-patient",
      title: "新規患者登録",
      body: `<p>初めて来局した患者はここから登録します（<kbd>Alt</kbd>+<kbd>N</kbd>）。患者番号は自動で振られ、登録後はそのまま薬歴の画面に移ります。</p>`,
    },
  ]);
  autoStartTour();
}
