// 起動の演出（ログイン画面）。アプリを立ち上げた瞬間（このタブで最初にログイン画面を開いたとき）だけ出す。
// ログアウトして戻ったとき・読み込み直したときは出さない（sessionStorage はタブを閉じるまで残る）。
// ログイン画面を、動画の最後の場面として扱う。前の場面にあった物が、そのままログイン画面の部品になる：
//   このブラウザで初めて開いたとき：紹介の PV（/promo）を流し、最後の「薬」のマークと題が、ログイン画面の印と見出しになる。
//     PV の青い背景は、ログイン画面の「薬」の印へ吸い込まれるように縮む（途中でスキップしたら、下の毎回の演出に回す）
//   毎回の起動：PV の最初の場面と同じ時刻表（約3秒）で、PTP シートから5錠が飛び出し、3錠が「ログインID」「パスワード」「ログイン」の印になり、空になったシートは入力欄の枠になる
// 演出の間もキーボードで入力できる（入力欄のフォーカスは最初から置いてあり、演出の部品はクリックを受けない）。
// <head> で読む普通の script：ログイン画面が描かれる前に隠しておくため。
// loginIntroDone は演出を出したら true、出さなかったら false で終わる（login.js はそれを見てチュートリアルを出す）
// replayIntro("pv" | "motion")：ログイン画面の「起動の演出をもう一度」のボタンから、PV から・錠剤の動きからを流し直す
(() => {
  const startup = sessionStorage.getItem("app-started") === null;
  sessionStorage.setItem("app-started", "1");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let done;
  window.loginIntroDone = new Promise((resolve) => { done = resolve; });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const center = (r) => [r.left + r.width / 2, r.top + r.height / 2];
  const EASE = "cubic-bezier(.65, 0, .25, 1)";
  // app.css の --ease-out / --ease-in / --ease-in-out と同じ曲線。等速では動かさない
  const EASE_OUT = "cubic-bezier(.22, 1, .36, 1)", EASE_IN = "cubic-bezier(.55, 0, .78, .3)", EASE_IN_OUT = "cubic-bezier(.65, 0, .35, 1)";
  // 何段もある動き（潰れて戻る・膨らんで消える）は段ごとに曲線をかける（WAAPI は書かないと段と段の間が等速になる）
  const eased = (frames, easing = EASE_IN_OUT) => frames.map((f, i) => (i === frames.length - 1 ? f : { easing, ...f }));
  let running = false;
  window.replayIntro = async (kind) => {
    if (running) return;
    running = true;
    const buttons = document.querySelectorAll(".replay .btn");
    buttons.forEach((b) => { b.disabled = true; }); // 流している間は押せない（終わったら戻す）
    document.documentElement.classList.add("login-intro");
    const pvEnded = kind === "pv" ? await playPv() : false;
    if (pvEnded) await pvToLogin(pvEnded);
    else await popTablets(); // PV をスキップしたときも、錠剤の動きからログイン画面へ
    buttons.forEach((el) => { el.disabled = false; });
    running = false;
  };
  if (!startup || reduced) {
    done(false);
    return;
  }
  const firstPv = localStorage.getItem("pv-seen") === null;
  document.documentElement.classList.add("login-intro");

  document.addEventListener("DOMContentLoaded", async () => {
    const pvEnded = firstPv ? await playPv() : false;
    if (pvEnded) await pvToLogin(pvEnded);
    else await popTablets();
    done(true);
  });


  // 錠剤を放物線で飛ばして、入力欄の印（.pill）に収める。
  //   道筋は2次ベジェの放物線を細かく区切って指定する（3点だけだと点と点の間が直線になり、「へ」の字に折れる）。
  //   進み方は投げた物と同じく、出だしが速く着地へ向けて緩む。回転と大きさは別の式で、途中でカクッと切り替わらない
  function flyTablet([sx, sy], pill, i, from = 0.8) {
    const to = pill.getBoundingClientRect();
    const [tx, ty] = center(to);
    const tab = document.createElement("i");
    tab.className = "intro-tablet";
    document.body.append(tab);
    const peak = Math.min(sy, ty) - 110;
    const [cx, cy] = [(sx + tx) / 2, 2 * peak - (sy + ty) / 2]; // 放物線の頂点が peak になる制御点
    const spin = i % 2 ? 320 : -320, end = to.width / 30, N = 30;
    const frames = Array.from({ length: N + 1 }, (_, j) => {
      const e = 1 - (1 - j / N) ** 1.7;
      const x = (1 - e) ** 2 * sx + 2 * (1 - e) * e * cx + e ** 2 * tx;
      const y = (1 - e) ** 2 * sy + 2 * (1 - e) * e * cy + e ** 2 * ty;
      const scale = from + (end - from) * e + 0.3 * Math.sin(Math.PI * e);
      return { transform: `translate(${x - 15}px, ${y - 15}px) rotate(${spin * e}deg) scale(${scale})` };
    });
    return tab.animate(frames, { duration: 720, easing: "linear", fill: "forwards" }).finished.then(() => {
      tab.remove();
      pill.style.visibility = "";
      return pill.animate(eased([{ transform: "scale(1.6, .6)" }, { transform: "scale(.85, 1.2)", offset: 0.5 }, { transform: "none" }]), { duration: 240 }).finished;
    });
  }

  // ログイン画面の残りの部品を、順に浮かび上がらせる
  function revealRest(items, start) {
    return Promise.all(items.map((el, i) => el.animate(
      [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
      { duration: 320, delay: start + i * 90, easing: EASE_OUT, fill: "backwards" },
    ).finished));
  }

  // ---------- 初回だけ：紹介の PV。最後まで見たら、最後の場面の位置（マーク・題）を返す ----------
  function playPv() {
    return new Promise((resolve) => {
      const box = document.createElement("div");
      box.className = "pv-first";
      box.innerHTML = '<iframe src="/promo?embed=1" title="紹介の動画"></iframe><button type="button" class="btn pv-skip">スキップ <kbd>Esc</kbd></button>';
      document.body.append(box);
      const frame = box.querySelector("iframe");
      frame.addEventListener("load", () => frame.contentWindow.focus());
      const finish = (ended) => {
        localStorage.setItem("pv-seen", "1");
        window.removeEventListener("message", onMessage);
        window.removeEventListener("keydown", onKey);
        document.querySelector("#login-id").focus();
        if (!ended) {
          box.remove();
          resolve(false);
          return;
        }
        const doc = frame.contentDocument;
        const pick = (sel) => doc.querySelector(sel).getBoundingClientRect();
        resolve({ box, mark: pick("#mark"), title: pick("#title"), subtitle: pick("#subtitle"), subtitleText: doc.querySelector("#subtitle").textContent });
      };
      const onMessage = (e) => { if (e.origin === location.origin && e.data?.type === "pv:end") finish(true); };
      const onKey = (e) => { if (e.key === "Escape") finish(false); };
      window.addEventListener("message", onMessage);
      window.addEventListener("keydown", onKey);
      box.querySelector(".pv-skip").addEventListener("click", () => finish(false));
    });
  }

  // PV の最後の場面 → ログイン画面
  async function pvToLogin(pv) {
    const mark = document.querySelector(".login-title .mark");
    const title = document.querySelector(".login-title h1");
    const [mx, my] = center(mark.getBoundingClientRect()), [px, py] = center(pv.mark);
    const tr = title.getBoundingClientRect(), [tx, ty] = center(tr), [qx, qy] = center(pv.title);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent");

    // PV と同じ青い背景を敷いてから PV を外す（つなぎ目を見せない）。背景はログイン画面の「薬」の印へ縮んでいく
    const flood = document.createElement("div");
    flood.className = "intro-flood";
    document.body.append(flood);
    const sub = document.createElement("div");
    sub.className = "intro-subtitle";
    sub.textContent = pv.subtitleText;
    Object.assign(sub.style, { left: `${pv.subtitle.left}px`, top: `${pv.subtitle.top}px`, fontSize: `${pv.subtitle.height * 0.78}px` });
    document.body.append(sub);
    document.documentElement.classList.add("intro-morph");
    const k = pv.mark.width / mark.getBoundingClientRect().width;
    const kt = pv.title.width / tr.width;
    const anims = [
      flood.animate([{ clipPath: `circle(150vmax at ${px}px ${py}px)` }, { clipPath: `circle(0px at ${mx}px ${my}px)` }], { duration: 820, easing: EASE, fill: "forwards" }),
      mark.animate([
        { transform: `translate(${px - mx}px, ${py - my}px) scale(${k})`, background: "#fff", color: accent },
        { transform: "none" },
      ], { duration: 820, easing: EASE, fill: "backwards" }),
      title.animate([
        { transform: `translate(${qx - tx}px, ${qy - ty}px) scale(${kt})`, color: "#fff" },
        { transform: "none" },
      ], { duration: 820, easing: EASE, fill: "backwards" }),
      sub.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(10px)" }], { duration: 300, easing: EASE_IN, fill: "forwards" }),
    ];
    const rest = revealRest([document.querySelector(".login-title p"), document.querySelector("#login-form"), document.querySelector(".demo-note"), document.querySelector(".replay"), document.querySelector(".login-title .tour-button")], 520);
    // 「薬」の印が着地する直前に、印から錠剤が3つ飛び出して、入力欄の印に入る（印はそのたびに小さく弾む）
    const pillEls = [...document.querySelectorAll(".login-box .pill")];
    pillEls.forEach((p) => { p.style.visibility = "hidden"; });
    const pills = pillEls.map((pill, i) => wait(760 + i * 110).then(() => {
      mark.animate(eased([{ transform: "none" }, { transform: "scale(1.12, .9)" }, { transform: "none" }]), { duration: 180, composite: "add" });
      return flyTablet([mx, my], pill, i);
    }));
    document.documentElement.classList.remove("login-intro"); // ここからは各部品の動き（開始の状態を保つ）が見え方を決める
    pv.box.remove();
    await Promise.all(anims.map((a) => a.finished));
    flood.remove();
    sub.remove();
    document.documentElement.classList.remove("intro-morph");
    await Promise.all([rest, ...pills]);
  }

  // ---------- 毎回の起動：PV の最初の場面と同じ時刻表で、PTP シートから錠剤が飛び出す ----------
  //   0〜0.45秒：シートが下から弾んで入る（傾き −6° から戻る）
  //   0.55・0.8・1.05・1.3・1.55秒：上の段の5錠が1つずつ飛び出し、シートの上に並んで浮く
  //   1.85秒：錠剤を出し終えたシートが、入力欄の枠（ログインのフォーム）へ伸びて重なり、枠と入れ替わる
  //   1.95秒：3錠が入力欄の印へ飛んで収まり、残りの2錠は膨らんで消える（PV では2錠が処方の行へ、3錠が消える）
  async function popTablets() {
    const form = document.querySelector("#login-form");
    const pills = [...document.querySelectorAll(".login-box .pill")];
    pills.forEach((p) => { p.style.visibility = "hidden"; });

    const W = 300, H = 112, cx = innerWidth / 2, cy = innerHeight / 2;
    const sheet = document.createElement("div");
    sheet.className = "intro-sheet";
    sheet.innerHTML = `<div class="bubbles">${"<i></i>".repeat(10)}</div>`;
    Object.assign(sheet.style, { left: `${cx - W / 2}px`, top: `${cy - H / 2}px`, width: `${W}px`, height: `${H}px` });
    document.body.append(sheet);
    const bubbles = [...sheet.querySelectorAll("i")].slice(0, 5);
    sheet.animate([{ transform: `translateY(${cy + H}px) rotate(-6deg)` }, { transform: "none" }],
      { duration: 450, easing: "cubic-bezier(.3, 1.4, .5, 1)", fill: "backwards" });
    wait(420).then(() => sheet.animate(eased([{ transform: "none" }, { transform: "scale(1.06, .94)" }, { transform: "scale(.98, 1.02)" }, { transform: "none" }]),
      { duration: 300, composite: "add" }));

    // 飛び出して、シートの上に並んで浮く（PV と同じ：弧を描いて上がり、1回転しながら 0.7倍 → 1倍）
    const POP = [550, 800, 1050, 1300, 1550];
    const hover = (i) => [cx + (i - 2) * 56, cy - H / 2 - 64];
    const tablets = await Promise.all(bubbles.map((b, i) => wait(POP[i]).then(() => {
      b.classList.add("popped");
      b.animate(eased([{ transform: "scale(1)" }, { transform: "scale(1.25, .8)" }, { transform: "scale(.92, 1.08)" }, { transform: "scale(1)" }]), { duration: 220 });
      const [sx, sy] = center(b.getBoundingClientRect()), [tx, ty] = hover(i);
      const tab = document.createElement("i");
      tab.className = "intro-tablet";
      document.body.append(tab);
      const spin = i % 2 ? 360 : -360, N = 24;
      const frames = Array.from({ length: N + 1 }, (_, j) => {
        const k = j / N, o = 1 - (1 - k) ** 3;
        const back = 1 + 3 * (k - 1) ** 3 + 2 * (k - 1) ** 2;
        const x = sx + (tx - sx) * o, y = sy + (ty - sy) * back - Math.sin(Math.PI * k) * 40;
        return { transform: `translate(${x - 15}px, ${y - 15}px) rotate(${spin * o}deg) scale(${0.7 + 0.3 * back})` };
      });
      tab.animate(frames, { duration: 450, easing: "linear", fill: "forwards" });
      return tab;
    })));

    // シートが入力欄の枠へ
    await wait(1850 - POP[4]);
    const f = form.getBoundingClientRect();
    sheet.querySelector(".bubbles").animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE_IN, fill: "forwards" });
    const grow = sheet.animate([
      { left: `${cx - W / 2}px`, top: `${cy - H / 2}px`, width: `${W}px`, height: `${H}px`, borderRadius: "14px", backgroundColor: "#e2e7ea", boxShadow: "inset 0 -45px 0 #d3d9de, 0 10px 24px rgba(0, 0, 0, .12)" },
      { left: `${f.left}px`, top: `${f.top}px`, width: `${f.width}px`, height: `${f.height}px`, borderRadius: "3px", backgroundColor: "#fff", boxShadow: "inset 0 0 0 #d3d9de, 0 0 0 rgba(0, 0, 0, 0)" },
    ], { duration: 340, easing: EASE, fill: "forwards" });

    // 3錠は入力欄の印へ、残りの2錠は膨らんで消える
    await wait(100);
    const flights = pills.map((pill, i) => wait(i * 90).then(() => {
      tablets[i].remove();
      return flyTablet(hover(i), pill, i, 1);
    }));
    const pops = tablets.slice(3).map((tab, j) => wait(j * 50).then(() => tab.animate(
      [{ scale: 1, easing: EASE_OUT }, { scale: 1.3, offset: 0.5, easing: EASE_IN }, { scale: 0 }], { duration: 160, fill: "forwards" }, // scale は transform とは別に効く（飛んだ位置のまま膨らむ）
    ).finished.then(() => tab.remove())));

    await grow.finished;
    const rest = revealRest([...document.querySelectorAll(".login-title > .mark, .login-title h1, .login-title p, .login-title .tour-button"), document.querySelector(".demo-note"), document.querySelector(".replay")], 0);
    document.documentElement.classList.remove("login-intro"); // 枠は、シートの下でそのまま見え始める
    await sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE_IN, fill: "forwards" }).finished;
    sheet.remove();
    await Promise.all([rest, ...flights, ...pops]);
  }
})();
