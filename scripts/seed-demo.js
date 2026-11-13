// デモ用の利用者・架空の患者・薬歴を作り、db/generated/seed.sql に書き出す。npm run db:seed から呼ぶ。
// 薬歴・メモ・指導記録は本番と同じ保存処理を、手元の SQLite に対して実行して作る。
// そのため点数・薬価は、画面から入力した場合と同じ計算で入る。
import { writeFileSync } from "node:fs";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { hashPassword, randomHex, ITERATIONS } from "../src/server/password.js";
import { createPatient } from "../src/server/patients.js";
import { createPrescription } from "../src/server/prescriptions.js";
import { createNotes, createRecord, createTemplate } from "../src/server/records.js";
import { createMeasurements } from "../src/server/measurements.js";
import { createTracing } from "../src/server/tracing.js";
import { registerHomePatient, createPlan, createSchedule, createVisitRecord } from "../src/server/homecare.js";
import { composeReport } from "../src/rules/home-visit-rules.js";

export const DEMO_LOGIN = { loginId: "demo", password: "pharmacy-demo" };

// 薬局は2つ。demo は1つ目、demo2 は2つ目の薬局の人で、互いの患者は見えない
const USERS = [
  { id: 1, pharmacyId: 1, loginId: DEMO_LOGIN.loginId, displayName: "デモ 薬剤師", password: DEMO_LOGIN.password },
  // 過去の薬歴の入力者。パスワードは乱数でログインには使わない
  { id: 2, pharmacyId: 1, loginId: "sato", displayName: "佐藤 薬剤師", password: randomHex(16) },
  { id: 3, pharmacyId: 2, loginId: "demo2", displayName: "デモ2 薬剤師", password: DEMO_LOGIN.password },
];
const SATO = { id: 2, pharmacy_id: 1 };

// 医薬品コード（支払基金の医薬品マスター）。金額は令和8年3月31日まで → 4月1日から
const D = {
  norvasc: "612170710",    // ノルバスク錠５ｍｇ       13.70円 → 10.80円
  atorva: "622098501",     // アトルバスタチン錠１０ｍｇ「サワイ」 13.90円 → 11.50円
  biofermin: "620000094",  // ビオフェルミン錠剤      5.90円 → 6.10円
  loxonin: "620098801",    // ロキソニン錠６０ｍｇ     10.40円 → 10.80円
  loxoninSentei: "670098801", // ロキソニン錠６０ｍｇ（選）：患者希望で先発品。6月1日から 10.65円（価格差の1/2 は 0.15円）
  mucosta: "620452801",    // ムコスタ錠１００ｍｇ     10.40円 → 10.80円
  mucodyne: "610407447",   // ムコダイン錠５００ｍｇ   10.40円 → 10.80円
  calonal: "620002023",    // カロナール錠２００       6.70円 → 6.50円
  magmitt: "610463198",    // マグミット錠３３０ｍｇ   6.30円
  kakkonto: "615101406",   // ツムラ葛根湯エキス顆粒（医療用） 13.40円（1g当たり）
  calonalFine: "620002022", // カロナール細粒２０％（1g当たり）
  widecillin: "621073001", // ワイドシリン細粒２０％（1g当たり）
  mucodyneDs: "621989901", // ムコダインＤＳ５０％（1g当たり）
};

// rx：処方箋の記載が調剤した薬と違うときだけ { name, dailyQty, reason }
const item = (drugCode, dailyQty, rx = null) => ({ drugCode, dailyQty, rx });
// 青木さんの経過：降圧剤＋整腸剤で開始 → 4月にスタチン追加 → 5月に整腸剤を中止
const norvasc = (days) => ({ usage: "1日1回朝食後", days, items: [item(D.norvasc, "1")] });
const norvascAtorva = (days) => ({ usage: "1日1回朝食後", days, items: [item(D.norvasc, "1"), item(D.atorva, "1")] });
const biofermin = (days) => ({ usage: "1日3回毎食後", days, items: [item(D.biofermin, "3")] });

// 患者・メモ・指導記録はすべて架空。来局日は令和8年4月の薬価改定をまたぎ、途中で薬の追加・中止・日数の変更が起きるようにしてある。
// 記録の内容は、処方している薬と矛盾しないようにした（例：マグミットの高齢者には腎機能と Mg 値の確認）。
const soap = (s, o, a, p, leftover = "none") =>
  ({ subjective: s, objective: o, assessment: a, plan: p, leftover });

const PATIENTS = [
  {
    name: "青木　誠", kana: "アオキ　マコト", birthDate: "1958-06-14", sex: "M", burdenPercent: 30, registeredOn: "2026-02-19",
    // 指導記録の O に書いた値と同じ検査値（4月の検査結果の用紙）
    labs: [{ on: "2026-04-16", source: "photo", values: [{ item: "ldl", value: "168" }] }],
    messages: [{ at: "2026-05-02T00:40:00Z", body: "コレステロールの薬を飲み始めてから、少し足がだるい気がします。様子を見ていて大丈夫でしょうか" }],
    notes: [
      { on: "2026-02-19", category: "adverse", body: "アムロジピン10mgで下肢のむくみ（2025年秋、内科で5mgに減量後は消失）" },
      { on: "2026-02-19", category: "disease", body: "高血圧症・脂質異常症（内科で治療中）" },
      { on: "2026-02-19", category: "concomitant", body: "市販の胃腸薬をときどき（銘柄は未確認。次回、現物を見せてもらう）" },
      { on: "2026-02-19", category: "lifestyle", body: "喫煙 1日10本。グレープフルーツはほとんど食べない" },
      { on: "2026-02-19", category: "generic", body: "血圧の薬は先発品のままを希望" },
      { on: "2026-02-19", category: "handover", body: "家庭血圧の手帳を毎回持参する。数値を一緒に見ると話が進む" },
    ],
    visits: [
      {
        on: "2026-02-19", by: 2, rps: [norvasc(28), biofermin(28)],
        record: soap("朝の血圧が140くらい。足のむくみはもうない。お腹がゆるい日が多い",
          "家庭血圧 朝138/86・夜128/80（手帳で確認）",
          "減量後むくみは消失。朝の値がやや高めだが服薬は良好",
          "家庭血圧の記録を続ける。次回、朝の値の推移を確認。禁煙の意向を聞く"),
      },
      // 3/19 は指導記録を書き忘れている（未記載の表示を見せるため）
      { on: "2026-03-19", by: 2, rps: [norvasc(28), biofermin(28)] },
      {
        on: "2026-04-16", by: 2, rps: [norvascAtorva(28), biofermin(28)],
        record: soap("内科で、コレステロールの薬が増えると言われた。4月から薬代が少し安くなった？",
          "LDL 168mg/dL（4月の検査結果の用紙で確認）。アトルバスタチン10mgが新しく追加。薬価改定で薬剤料は下がった",
          "スタチンの開始。筋肉痛・だるさなど初期の副作用に注意が必要",
          "筋肉の痛み・だるさ・尿の色が濃いときは連絡するよう説明。次回、副作用の有無と飲み忘れを確認"),
      },
      {
        on: "2026-05-14", by: 2, rps: [norvascAtorva(28)],
        record: soap("お腹の調子は落ち着いた。筋肉痛はない。たばこを1日5本に減らした",
          "家庭血圧 朝128/82。ビオフェルミンは内科の判断で中止",
          "スタチンの副作用は出ていない。減煙できており、血圧も目標に近づいている",
          "減煙を続けられるよう声をかける。次回、禁煙外来の案内を検討"),
      },
    ],
  },
  {
    name: "石川　美咲", kana: "イシカワ　ミサキ", birthDate: "1990-11-02", sex: "F", burdenPercent: 30, registeredOn: "2026-03-25",
    messages: [
      { at: "2026-09-30T10:05:00Z", body: "頭痛がひどい日が増えました。次の受診で相談したいので、前にもらった薬の名前を教えてください" },
      { at: "2026-09-30T10:30:00Z", out: true, body: "3月はロキソニン錠60mgをお渡ししています。受診のときにお薬手帳もお持ちください" },
    ],
    notes: [
      { on: "2026-03-25", category: "allergy", body: "セフェム系抗菌薬で発疹（2019年、他院）" },
      { on: "2026-03-25", category: "lifestyle", body: "妊娠の可能性なし（2026/03/25 本人に確認）" },
      { on: "2026-03-25", category: "generic", body: "後発品で構わない" },
      { on: "2026-03-25", category: "handover", body: "仕事帰りの受け取りが多い。説明は要点を短く" },
    ],
    visits: [
      {
        on: "2026-03-25", by: 2, handbook: "none", rps: [
          { usage: "1日3回毎食後", days: 5, items: [item(D.loxonin, "3"), item(D.mucosta, "3")] },
          { usage: "1日3回毎食後", days: 5, items: [item(D.mucodyne, "3")] },
        ],
        record: soap("のどが痛く、熱が38度ある",
          "抗菌薬の処方なし。セフェム系の発疹歴は処方医も把握済み（問診票で確認）",
          "解熱鎮痛薬と胃粘膜保護薬の組み合わせで問題なし",
          "空腹時を避けて飲む。3日たっても熱が下がらなければ再受診", "none"),
      },
      {
        on: "2026-10-08", by: 2, rps: [
          { usage: "1日3回毎食後", days: 3, items: [item(D.calonal, "6")] },
        ],
        record: soap("頭痛がひどい日だけ飲みたい",
          "カロナール1回2錠。3月に出たロキソニンが3錠残っている",
          "ロキソニンとの重複服用に注意が必要",
          "カロナールを飲んでいる間はロキソニンを飲まない。残薬は次回持参を依頼", "some"),
      },
    ],
  },
  {
    name: "遠藤　和子", kana: "エンドウ　カズコ", birthDate: "1945-03-08", sex: "F", burdenPercent: 10, registeredOn: "2026-06-11",
    labs: [
      { on: "2026-06-05", source: "photo", values: [{ item: "egfr", value: "48" }, { item: "cr", value: "0.86" }] },
      { on: "2026-08-20", source: "manual", values: [{ item: "mg", value: "2.4" }] },
    ],
    notes: [
      { on: "2026-06-11", category: "disease", body: "慢性便秘。腎機能がやや低下（eGFR 48、2026/06 内科の検査）" },
      { on: "2026-06-11", category: "concomitant", body: "整形外科でロキソプロフェンのテープ剤" },
      { on: "2026-06-11", category: "generic", body: "後発品で可" },
      { on: "2026-06-11", category: "handover", body: "耳が遠いので正面からゆっくり話す。娘さんが付き添うことが多い" },
    ],
    visits: [
      {
        on: "2026-06-11", by: 2, rps: [
          { usage: "1日3回毎食後", days: 14, items: [item(D.magmitt, "3")] },
          { usage: "1日3回毎食前", days: 7, items: [item(D.kakkonto, "7.5")] },
        ],
        record: soap("便秘が続いている。風邪気味",
          "eGFR 48（検査結果の用紙で確認）",
          "高齢で腎機能が低下しており、マグネシウムがたまりやすい",
          "だるさ・吐き気が出たら連絡するよう説明。次回、血清 Mg 値の検査予定を確認"),
      },
      {
        // 残薬が7日分あったので、処方医に照会して28日分を21日分に減らした（調剤時残薬調整加算）
        on: "2026-09-17", by: 2, rps: [
          { usage: "1日3回毎食後", rxDays: 28, days: 21, daysChange: "inquiry", items: [item(D.magmitt, "3")] },
        ],
        inquiries: [{
          rpNo: 1, drugCode: D.magmitt,
          kind: "leftover",
          content: "マグミット錠が7日分残っている（本人と娘さんに確認。昼の飲み忘れ）。28日分を21日分に減らしてよいか",
          answer: "21日分で可（○○内科 医師）",
          changed: true,
        }],
        record: soap("お通じは毎日ある。昼の薬を飲み忘れることがある",
          "血清 Mg 2.4mg/dL（8月の検査）。マグミット錠の残薬 7日分（21錠）",
          "Mg 値は基準内。便秘は改善",
          "症状の聞き取りを続ける。Mg 値の定期測定を処方医に確認"),
      },
    ],
  },
  {
    // 小児：体重から分量を確かめる（処方入力の「小児の分量」）。量はどれも添付文書の通常量の範囲内
    //   カロナール細粒20% 1日2.7g（1回180mg = 10mg/kg）、ワイドシリン細粒20% 1日3g（600mg = 33.3mg/kg/日）、ムコダインDS50% 1日1.08g（540mg = 30mg/kg/日）
    name: "上田　陽向", kana: "ウエダ　ヒナタ", birthDate: "2021-05-10", sex: "M", burdenPercent: 20, registeredOn: "2026-10-20",
    labs: [{ on: "2026-10-20", source: "manual", values: [{ item: "weight", value: "18.0" }] }],
    notes: [
      { on: "2026-10-20", category: "handover", body: "粉薬は嫌がるので、アイスやジュースに混ぜる方法を母に説明すると喜ばれる" },
    ],
    visits: [{
      on: "2026-10-20", by: 2, rps: [
        { usage: "1日3回毎食後", days: 5, items: [item(D.calonalFine, "2.7")] },
        { usage: "1日3回毎食後", days: 5, items: [item(D.widecillin, "3"), item(D.mucodyneDs, "1.08")] },
      ],
      record: soap("（母より）おとといから38度台の熱。のどを痛がる",
        "体重 18.0kg（本日、薬局で測定）。分量はどれも体重当たりの通常量の範囲内",
        "抗菌薬は飲み切ることが大事。解熱剤は熱が下がれば中止できる",
        "抗菌薬は5日分を飲み切るよう母に説明。発疹・ひどい下痢があれば連絡。解熱剤は1日3回まで、6時間以上あける"),
    }],
  },
  { name: "宇野　健太", kana: "ウノ　ケンタ", birthDate: "2001-08-20", sex: "M", burdenPercent: 30, registeredOn: "2026-10-30", notes: [], visits: [] },
  {
    name: "小野寺　隆", kana: "オノデラ　タカシ", birthDate: "1972-01-30", sex: "M", burdenPercent: 30, registeredOn: "2026-10-28",
    notes: [
      { on: "2026-10-28", category: "disease", body: "高血圧症・脂質異常症（2026/10 から治療開始）" },
      { on: "2026-10-28", category: "lifestyle", body: "飲酒 毎日ビール500mL" },
    ],
    // 最新の来局は指導記録が未記載のまま（薬歴画面の「未記載」の表示を見せるため）
    // 処方箋はアトルバスタチンが一般名で書かれていて、薬局で銘柄を選んだ
    visits: [{
      on: "2026-10-28", by: 2, rps: [{
        usage: "1日1回朝食後", days: 14, items: [
          item(D.norvasc, "1"),
          item(D.atorva, "1", { name: "【般】アトルバスタチン錠１０ｍｇ", dailyQty: "1", reason: "general" }),
        ],
      }],
    }],
  },
  {
    // 長期収載品の選定療養：後発品があるのに先発品を希望した患者。薬剤料は（選）の金額で、特別の料金を別に受け取る
    name: "加藤　真一", kana: "カトウ　シンイチ", birthDate: "1966-04-22", sex: "M", burdenPercent: 30, registeredOn: "2026-10-22",
    notes: [
      { on: "2026-10-22", category: "generic", body: "ロキソニンは先発品を希望。選定療養の特別の料金がかかることを説明し、了承済み（2026/10/22）" },
      { on: "2026-10-22", category: "disease", body: "腰痛症（整形外科）" },
    ],
    visits: [{
      on: "2026-10-22", by: 2, handbook: "electronic", rps: [
        { usage: "1日3回毎食後", days: 14, items: [item(D.loxoninSentei, "3"), item(D.mucosta, "3")] },
      ],
      record: soap("前に後発品で胃が荒れた気がするので、先発品にしてほしい",
        "後発品で胃の不調があったとの申告（時期・銘柄は不明）。他に飲んでいる薬はない",
        "医師の指示は後発品可。先発品は本人の希望",
        "先発品を希望する場合は特別の料金（選定療養）がかかることを説明。胃の症状が続くときは受診を勧めた"),
    }],
  },
];

// 薬局（架空）。領収証・お薬手帳に出す
const PHARMACIES = [
  { id: 1, name: "サンプル薬局（デモ用・架空）", prefectureCode: "13", pharmacyCode: "9999999",
    postalCode: "100-0000", address: "東京都千代田区（架空の住所）", phone: "03-0000-0000" },
  { id: 2, name: "サンプル第二薬局（デモ用・架空）", prefectureCode: "20", pharmacyCode: "9999998",
    postalCode: "386-0000", address: "長野県上田市（架空の住所）", phone: "0268-00-0000" },
];
// 届出（施設基準）。令和8年6月の改定で区分の名前と点数が変わるので、改定日に届け直した形にする
const FACILITY = [
  { validFrom: "2025-04-01", basicFee: "1", communitySupport: 0, renkei: 1, genericSystem: 2, iryoDx: 3, iryoJoho: 1, denshiRenkei: 0, baseUp: 0 },
  { validFrom: "2026-06-01", basicFee: "1", communitySupport: 1, renkei: 1, genericSystem: 0, iryoDx: 0, iryoJoho: 0, denshiRenkei: 1, baseUp: 1 },
];

const OUT = "db/generated/seed.sql";
const db = openD1("db/schema.sql", "db/generated/master.sql");

for (const ph of PHARMACIES) {
  await db.prepare(`INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(ph.id, ph.name, ph.prefectureCode, ph.pharmacyCode, ph.postalCode, ph.address, ph.phone).run();
  for (const f of FACILITY) {
    await db.prepare(`INSERT INTO pharmacy_facility (pharmacy_id, valid_from, basic_fee, community_support, renkei, generic_system, iryo_dx, iryo_joho, denshi_renkei, base_up)
                      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
      .bind(ph.id, f.validFrom, f.basicFee, f.communitySupport, f.renkei, f.genericSystem, f.iryoDx, f.iryoJoho, f.denshiRenkei, f.baseUp).run();
  }
}

for (const u of USERS) {
  const salt = randomHex(16);
  await db
    .prepare("INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(u.id, u.pharmacyId, u.loginId, u.displayName, await hashPassword(u.password, salt), salt, ITERATIONS)
    .run();
}

// デモの薬局の採用薬（処方入力の候補で一番上に出る）。同じ成分・規格の銘柄から1つを決めた（db/migrations/2026-11-13-adopted-drugs.sql と同じ）
const ADOPTED = [
  "620007870", // アムロジピン錠５ｍｇ「サワイ」
  "622588801", // ロスバスタチン錠２．５ｍｇ「サワイ」
  "620009465", // レバミピド錠１００ｍｇ「サワイ」
  "622098501", // アトルバスタチン錠１０ｍｇ「サワイ」
  "610463198", // マグミット錠３３０ｍｇ
  "620002023", // カロナール錠２００
];
for (const code of ADOPTED) {
  await db.prepare("INSERT INTO adopted_drugs (pharmacy_id, drug_code, adopted_at, adopted_by) VALUES (1, ?1, '2026-04-01T00:00:00.000Z', 1)").bind(code).run();
}

// 日時は来局日の日中にしておく（実行した日時のままだと、過去の薬歴として不自然になる）
const at = (date, hhmm) => `${date}T${hhmm}:00.000Z`;
const patientIds = new Map(); // 氏名 → 患者ID
for (const p of PATIENTS) {
  const { id } = await createPatient(db, SATO, p);
  patientIds.set(p.name, id);
  await db.prepare("UPDATE patients SET created_at = ?1 WHERE id = ?2").bind(at(p.registeredOn, "01:00"), id).run();
  for (const [category, list] of Map.groupBy(p.notes, (n) => n.category)) { // 患者メモは分類ごとに1つ
    const notes = await createNotes(db, SATO, id, { notes: list });
    await db.prepare("UPDATE patient_notes SET created_at = ?1 WHERE id = ?2").bind(at(list.at(-1).on, "01:10"), notes.find((n) => n.category === category).id).run();
  }
  for (const v of p.visits) {
    const rx = await createPrescription(db, { id: v.by, pharmacy_id: 1 }, {
      patientId: id, prescribedOn: v.on, dispensedOn: v.on, handbook: v.handbook ?? "paper", inquiries: v.inquiries ?? [],
      rps: v.rps.map((rp) => ({ rxDays: rp.days, daysChange: null, ...rp })),
    });
    await db.prepare("UPDATE prescriptions SET created_at = ?1 WHERE id = ?2").bind(at(v.on, "01:30"), rx.id).run();
    await db.prepare("UPDATE inquiries SET created_at = ?1 WHERE prescription_id = ?2").bind(at(v.on, "01:20"), rx.id).run();
    if (v.record) {
      const rec = await createRecord(db, { id: v.by, pharmacy_id: 1 }, rx.id, v.record);
      await db.prepare("UPDATE guidance_records SET created_at = ?1 WHERE id = ?2").bind(at(v.on, "01:45"), rec.id).run();
    }
  }
  for (const l of p.labs ?? []) {
    await createMeasurements(db, SATO, id, { measuredOn: l.on, source: l.source, values: l.values });
    await db.prepare("UPDATE measurements SET created_at = ?1 WHERE patient_id = ?2 AND measured_on = ?3").bind(at(l.on, "01:15"), id, l.on).run();
  }
  // つながる薬局のやり取り（受信は送信時刻で入れる）
  for (const m of p.messages ?? []) {
    await db.prepare("INSERT INTO line_messages (patient_id, direction, body, sent_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, m.out ? "out" : "in", m.body, m.at, m.out ? 2 : null).run();
  }
}

// 2つ目の薬局の患者。demo では見えず、demo2 でログインすると見える
await createPatient(db, { id: 3, pharmacy_id: 2 },
  { name: "上田　一郎", kana: "ウエダ　イチロウ", birthDate: "1960-05-05", sex: "M", burdenPercent: 30 });

// 指導記録のテンプレート
const TEMPLATES = [
  { title: "定期・変わりなし", subjective: "体調に変わりはない。", objective: "前回と同じ処方。", assessment: "服薬は良好。", plan: "同じ飲み方で続けるよう説明。次回も体調の変化と飲み忘れを確認。" },
  { title: "新しい薬が始まった", subjective: "", objective: "今回から新しい薬が追加。", assessment: "初期の副作用の確認が必要。", plan: "飲み方と主な副作用を説明。気になる症状があれば連絡するよう伝えた。次回、副作用の有無を確認。" },
  { title: "残薬あり", subjective: "飲み忘れることがある。", objective: "残薬あり。", assessment: "飲み忘れの原因の確認が必要。", plan: "飲み忘れやすい時間を一緒に確認。お薬カレンダーの利用を提案。次回、残薬の数を確認。" },
];
for (const t of TEMPLATES) await createTemplate(db, SATO, t);

// 在宅：遠藤さん（自宅）。計画書 → 10月に2回訪問して記録 → 11月の予定
const endo = patientIds.get("遠藤　和子");
await registerHomePatient(db, SATO, {
  patientId: endo, facilityId: null, institution: "○○内科クリニック（架空）", doctor: "山田", careManager: "佐々木",
  intensive: false, startedOn: "2026-10-01",
});
await createPlan(db, SATO, endo, {
  madeOn: "2026-10-01", visitsPerMonth: 2, intervalText: "第2・第4木曜",
  management: "1回分ずつの一包化はせず、お薬カレンダー（朝・昼・夕）に娘さんが1週間分をセットする",
  drugNotes: "マグミット（酸化マグネシウム）：腎機能が低い（eGFR 48）ため高マグネシウム血症に注意。吐き気・だるさ・脱力の有無を確認",
  guidance: "昼の飲み忘れの確認と、カレンダーのセットの方法の確認。便通と Mg 値（検査があれば）の確認",
});
const VISITS = [
  { on: "2026-10-08", record: { storage: "居間のお薬カレンダーに1週間分。直射日光の当たらない場所", adherence: "朝・夕は飲めている。昼を週2回ほど飲み忘れ", leftover: "マグミット錠 4錠", guidance: "昼の分をカレンダーの見やすい位置に移した。娘さんに昼の声かけをお願いした", shared: "ケアマネジャー（佐々木）に、昼の声かけをヘルパーにも頼めるか相談" } },
  { on: "2026-10-22", record: { storage: "カレンダーで管理。問題なし", adherence: "昼の飲み忘れは週1回に減った", leftover: "マグミット錠 2錠", guidance: "飲み忘れが減ったことを本人と確認。便通は毎日", shared: "" } },
  { on: "2026-11-05" },
  { on: "2026-11-19" },
];
for (const v of VISITS) {
  const { id: scheduleId } = await createSchedule(db, SATO, { patientId: endo, visitOn: v.on, pharmacistId: 2 });
  if (v.record) {
    const report = composeReport({ visit: v.record, record: { subjective: "お通じは毎日ある。昼の薬を飲み忘れることがある", assessment: "Mg 値は基準内。便秘は改善", plan: "症状の聞き取りを続ける。Mg 値の定期測定を処方医に確認" } });
    await createVisitRecord(db, SATO, scheduleId, { ...v.record, report });
    await db.prepare("UPDATE visit_records SET created_at = ?1 WHERE schedule_id = ?2").bind(at(v.on, "06:00"), scheduleId).run();
  }
}

// トレーシングレポート：遠藤さんの9月の来局（残薬調整）から、処方医へ
const endoRx = await db.prepare("SELECT id FROM prescriptions WHERE patient_id = ?1 AND dispensed_on = '2026-09-17'").bind(endo).first();
await createTracing(db, SATO, endo, {
  prescriptionId: endoRx.id, institution: "○○内科クリニック（架空）", department: "内科", doctor: "山田", consent: "agreed",
  adherence: "昼の分を週2回ほど飲み忘れています（本人・娘さんより）。朝・夕は飲めています。",
  leftover: "マグミット錠が7日分残っていたため、9月17日の処方を28日分から21日分に減らしました（疑義照会でご了承いただきました）。",
  concomitant: "整形外科でロキソプロフェンのテープ剤を使っています。",
  complaint: "", family: "娘さんが付き添い、お薬カレンダーのセットを手伝っています。",
  proposal: "昼の飲み忘れが続くようでしたら、朝・夕の2回にまとめられる処方をご検討いただけないでしょうか。腎機能（eGFR 48）を踏まえ、Mg 値の定期的な測定もお願いいたします。",
  other: "", nextVisitOn: "2026-10-15",
});
await db.prepare("UPDATE tracing_reports SET created_at = ?1").bind(at("2026-09-17", "03:00")).run();

// 回覧板：本部からの通知（pharmacy_id null）と、サンプル薬局の申し送り・連絡・相談。患者の情報は書かない。db/migrations/2026-11-13-notices.sql と同じ
const NOTICES = [
  {
    "id": 1,
    "pharmacyId": null,
    "kind": "hq",
    "sender": "本部 薬事部",
    "createdBy": null,
    "createdAt": "2026-11-04T00:30:00.000Z",
    "body": "11月1日から一部の品目の薬価が変わっています（年度の途中の変更）。\n各店で「マスター取込」に最新の改定分（.csv）を取り込み、調剤日が11月1日以降の処方で金額が新しくなっていることを確かめてください。"
  },
  {
    "id": 2,
    "pharmacyId": null,
    "kind": "periodic",
    "sender": "本部 営業部",
    "createdBy": null,
    "createdAt": "2026-11-05T08:00:00.000Z",
    "body": "10月の月報を出しました。今月から、店ごとの後発医薬品の使用割合も並べています。\n自店の数字は左のメニューの「薬局の数字」で見られます。"
  },
  {
    "id": 3,
    "pharmacyId": null,
    "kind": "pr",
    "sender": "本部 広報",
    "createdBy": null,
    "createdAt": "2026-11-10T01:00:00.000Z",
    "body": "インフルエンザの流行期に入りました 🍵\n待合のポスターを11月版に差し替えます。今週中に各店へ届きます。古いポスターは外して捨ててください。"
  },
  {
    "id": 4,
    "pharmacyId": 1,
    "kind": "handover",
    "sender": null,
    "createdBy": 2,
    "createdAt": "2026-11-12T04:05:00.000Z",
    "body": "午前→午後の申し送りです。\n・卸の午後便で、在庫が切れていた錠剤が入ります。届いたら棚の補充をお願いします\n・14時ごろ、近くのクリニックから処方日数の件で折り返しの電話があります（内容は薬歴に書きました）"
  },
  {
    "id": 5,
    "pharmacyId": 1,
    "kind": "contact",
    "sender": null,
    "createdBy": 1,
    "createdAt": "2026-11-12T09:10:00.000Z",
    "body": "分包紙の在庫が残り1箱です。明日の発注に入れました。"
  },
  {
    "id": 6,
    "pharmacyId": 1,
    "kind": "consult",
    "sender": null,
    "createdBy": 2,
    "createdAt": "2026-11-13T00:12:00.000Z",
    "body": "年末年始の営業時間の貼り紙、去年の文面を使い回してもいいでしょうか？ 休みの日は本部の案内（12/29〜1/3）のとおりです。"
  }
];
const NOTICE_READS = [{"noticeId": 1, "userId": 1, "readAt": "2026-11-04T01:00:00.000Z"}, {"noticeId": 2, "userId": 1, "readAt": "2026-11-05T09:00:00.000Z"}, {"noticeId": 4, "userId": 1, "readAt": "2026-11-12T04:30:00.000Z"}, {"noticeId": 5, "userId": 1, "readAt": "2026-11-12T09:10:00.000Z"}, {"noticeId": 1, "userId": 2, "readAt": "2026-11-04T02:00:00.000Z"}, {"noticeId": 3, "userId": 2, "readAt": "2026-11-10T02:00:00.000Z"}, {"noticeId": 4, "userId": 2, "readAt": "2026-11-12T04:05:00.000Z"}, {"noticeId": 5, "userId": 2, "readAt": "2026-11-13T00:05:00.000Z"}, {"noticeId": 6, "userId": 2, "readAt": "2026-11-13T00:12:00.000Z"}];
for (const n of NOTICES) {
  await db.prepare("INSERT INTO notices (id, pharmacy_id, kind, body, sender, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(n.id, n.pharmacyId, n.kind, n.body, n.sender, n.createdAt, n.createdBy).run();
}
for (const r of NOTICE_READS) {
  await db.prepare("INSERT INTO notice_reads (notice_id, user_id, read_at) VALUES (?1, ?2, ?3)").bind(r.noticeId, r.userId, r.readAt).run();
}

// 作った行を INSERT 文にして書き出す。アクセスログは本物の操作だけを残したいので書き出さない
const TABLES = ["pharmacies", "pharmacy_facility", "users", "adopted_drugs", "patients", "patient_notes", "prescriptions", "prescription_rps",
  "prescription_items", "inquiries", "prescription_fees", "conversations", "guidance_records", "measurements", "guidance_templates",
  "tracing_reports", "facilities", "home_patients", "care_plans", "visit_schedules", "visit_records", "line_messages", "notices", "notice_reads"];
const lines = ["DELETE FROM access_logs;", "DELETE FROM sessions;", "DELETE FROM mfa_challenges;", "DELETE FROM inspection_scans;", "DELETE FROM inspections;",
  "DELETE FROM reception_steps;", "UPDATE prescriptions SET reception_id = NULL;", "DELETE FROM receptions;", ...[...TABLES].reverse().map((t) => `DELETE FROM ${t};`)];
for (const t of TABLES) {
  const { results } = await db.prepare(`SELECT * FROM ${t}`).all();
  for (const row of results) {
    const cols = Object.keys(row);
    lines.push(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => sqlValue(row[c])).join(", ")});`);
  }
}
// 在庫：全部の薬局・全部の薬を 100 から始める（薬は約1万3千品目あるので、行を書き出さず SQL 1本で入れる）
lines.unshift("DELETE FROM drug_stock;");
lines.push("INSERT INTO drug_stock (pharmacy_id, drug_code, qty_milli, updated_at) SELECT p.id, d.code, 100000, '2026-11-13T00:00:00.000Z' FROM pharmacies p CROSS JOIN drugs d;");
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");

const n = async (t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
console.log(`利用者 ${await n("users")} / 患者 ${await n("patients")} / メモ ${await n("patient_notes")} / 処方 ${await n("prescriptions")} / 指導記録 ${await n("guidance_records")} → ${OUT}`);
console.log(`デモ用ログイン  ID: ${DEMO_LOGIN.loginId}  パスワード: ${DEMO_LOGIN.password}`);

function sqlValue(v) {
  if (v === null) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
