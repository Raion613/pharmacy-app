-- テーブル定義。npm run db:init で空の状態から作り直す。
-- 金額は全て「銭（1/100円）の整数」、1日量は「1/1000単位の整数」で持つ（小数の誤差を持ち込まない）。
-- 日付は 'YYYY-MM-DD' の文字列。文字列のまま大小比較できる。

DROP TABLE IF EXISTS access_logs;
DROP TABLE IF EXISTS guidance_records;
DROP TABLE IF EXISTS patient_notes;
DROP TABLE IF EXISTS prescription_fees;
DROP TABLE IF EXISTS inquiries;
DROP TABLE IF EXISTS prescription_items;
DROP TABLE IF EXISTS prescription_rps;
DROP TABLE IF EXISTS prescriptions;
DROP TABLE IF EXISTS patients;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS staging_fee_rows;
DROP TABLE IF EXISTS staging_rows;
DROP TABLE IF EXISTS pending_imports;
DROP TABLE IF EXISTS fee_points;
DROP TABLE IF EXISTS fee_items;
DROP TABLE IF EXISTS drug_prices;
DROP TABLE IF EXISTS drugs;
DROP TABLE IF EXISTS master_imports;
DROP TABLE IF EXISTS pharmacy_facility;
DROP TABLE IF EXISTS pharmacy_profile;
DROP TABLE IF EXISTS users;

-- 薬価と調剤報酬の点数の出どころは、社会保険診療報酬支払基金（医療情報基盤・診療報酬審査支払機構）の基本マスター。
--   医薬品マスター   … 全件ファイル（y_ALL….csv）と改定分ファイル（y_….csv）。内用薬だけを入れる
--   調剤行為マスター … 全件ファイル（m….csv）。調剤基本料・薬剤調製料・薬学管理料などの算定項目と点数
-- 公表されるたびに取り込む。どちらも1行が「変更年月日から、この内容」を表す。

-- 取り込んだマスターのファイル
CREATE TABLE master_imports (
  id            INTEGER PRIMARY KEY,
  master        TEXT NOT NULL CHECK (master IN ('drug', 'fee')), -- 医薬品マスター / 調剤行為マスター
  kind          TEXT NOT NULL CHECK (kind IN ('full', 'diff')), -- 全件 / 改定分
  published_on  TEXT NOT NULL,          -- 支払基金の公表日
  file_name     TEXT NOT NULL,
  row_count     INTEGER NOT NULL,       -- 取り込んだ行（内用薬）
  changed_count INTEGER NOT NULL,       -- 薬価の履歴に書いた行
  imported_at   TEXT NOT NULL,
  imported_by   INTEGER REFERENCES users(id), -- 初期データは NULL
  pending_id    TEXT NOT NULL UNIQUE    -- 取り込み中の作業（pending_imports.id）との対応
);

-- 薬（医薬品コードごと）。名称などは、公表日がいちばん新しいマスターの内容にする。
-- 長期収載品は、医療上必要な場合のコード（sentei = 1）と、患者希望で選定療養になるコード（sentei = 2、名称の末尾が「（選）」）が別にある。
CREATE TABLE drugs (
  code               TEXT PRIMARY KEY,  -- 医薬品コード（レセプト電算処理用、9桁）
  yj_code            TEXT NOT NULL,     -- 薬価基準収載医薬品コード（12桁）
  name               TEXT NOT NULL,     -- 基本漢字名称（品名）
  unit               TEXT NOT NULL,     -- 薬価の単位（錠、g、mL …）。薬価はこの単位1つ当たり
  generic            INTEGER NOT NULL CHECK (generic IN (0, 1)), -- 加算等の算定対象となる後発医薬品
  general_name       TEXT,              -- 一般名処方の標準的な記載（無い薬もある）
  sentei             INTEGER NOT NULL CHECK (sentei IN (0, 1, 2)), -- 選定療養区分
  pair_code          TEXT,              -- sentei = 2 のとき、対になる sentei = 1 のコード
  narcotic           INTEGER NOT NULL CHECK (narcotic IN (0, 1, 2, 3, 5)), -- 1 麻薬 2 毒薬 3 覚醒剤原料 5 向精神薬（薬剤調製料の加算）
  name_key           TEXT NOT NULL,     -- 検索用（全角半角・ひらがなカタカナを揃えた品名）
  general_key        TEXT NOT NULL,     -- 検索用（同じく一般名）
  attrs_published_on TEXT NOT NULL      -- 名称などを取ったマスターの公表日
);

-- 薬価の履歴。「ある日付時点の薬価」は、その日付以前で最も新しい valid_from の行。
-- マスターの1行は「変更年月日から、この薬価」を表すので、その日に薬価や経過措置が変わるときだけ行を足す。
CREATE TABLE drug_prices (
  drug_code          TEXT NOT NULL REFERENCES drugs(code),
  valid_from         TEXT NOT NULL,     -- 適用開始日（マスターの変更年月日。廃止は廃止年月日の翌日）
  import_id          INTEGER NOT NULL REFERENCES master_imports(id),
  price_sen          INTEGER,           -- NULL＝この日以降は使えない（廃止・抹消・マスターから消えた）
  transitional_until TEXT,              -- 経過措置による使用期限（この日まで使える）
  PRIMARY KEY (drug_code, valid_from)
);

CREATE INDEX idx_drugs_name_key ON drugs(name_key);

-- 調剤報酬の算定項目（調剤行為コードごと）
CREATE TABLE fee_items (
  code               TEXT PRIMARY KEY,  -- 調剤行為コード（9桁、先頭は4）
  name               TEXT NOT NULL,     -- いちばん新しいマスターの漢字名称
  attrs_published_on TEXT NOT NULL
);

-- 算定項目の点数と名称の履歴。考え方は drug_prices と同じ。
-- 名称も日付で持つ（改定で同じコードの名称が変わることがある。例：440012210 は令和6年度「服薬管理指導料（３月以内再度処方箋以外）」、
-- 令和8年度「服薬管理指導料２（イ）（かかりつけ・３月内以外）」）
CREATE TABLE fee_points (
  code        TEXT NOT NULL REFERENCES fee_items(code),
  valid_from  TEXT NOT NULL,
  import_id   INTEGER NOT NULL REFERENCES master_imports(id),
  name        TEXT,                     -- その日の名称（明細書に出す）。NULL＝廃止
  point_kind  TEXT,                     -- 3 点数 5 %加算 6 %減算 7 分数減算 8 整数倍 9 点数（マイナス）。NULL＝廃止
  points_x100 INTEGER,                  -- 点数の100倍（マスターは下2桁を小数で持つ）。NULL＝この日以降は使えない
  PRIMARY KEY (code, valid_from)
);

-- 取り込み中のマスター。ブラウザが読んだ行を何回かに分けて送り、ここに貯める。
-- 「取り込む」で1つのトランザクションとして drugs / drug_prices に反映し、ここは消す。途中で止めたら、ここを消すだけで元のまま。
CREATE TABLE pending_imports (
  id            TEXT PRIMARY KEY,
  master        TEXT NOT NULL CHECK (master IN ('drug', 'fee')),
  kind          TEXT NOT NULL CHECK (kind IN ('full', 'diff')),
  published_on  TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  expected_rows INTEGER NOT NULL CHECK (expected_rows > 0),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL
);

-- 取り込み中の行。改定分のファイルは変わった項目しか入っていないので、NULL＝「この項目は変更なし」。
-- 空文字＝「値なし」（一般名が無い・経過措置が無い・廃止年月日が無い など）。
CREATE TABLE staging_rows (
  pending_id         TEXT NOT NULL REFERENCES pending_imports(id),
  line_no            INTEGER NOT NULL,  -- ファイルの行番号
  change_kind        TEXT NOT NULL CHECK (change_kind IN ('0', '1', '3', '5', '9')), -- 変更区分
  code               TEXT NOT NULL CHECK (length(code) = 9 AND code GLOB '6[0-9]*'),
  yj_code            TEXT,
  name               TEXT,
  unit               TEXT,
  generic            INTEGER CHECK (generic IN (0, 1)),
  general_name       TEXT,
  general_key        TEXT,
  name_key           TEXT,
  sentei             INTEGER CHECK (sentei IN (0, 1, 2)),
  pair_code          TEXT,
  narcotic           INTEGER CHECK (narcotic IN (0, 1, 2, 3, 5)),
  price_sen          INTEGER CHECK (price_sen >= 0),
  change_date        TEXT NOT NULL CHECK (change_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date           TEXT CHECK (end_date = '' OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  transitional_until TEXT CHECK (transitional_until = '' OR transitional_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (pending_id, code)
);

-- 取り込み中の調剤行為マスターの行（全件ファイルだけなので、どの項目も入っている）
CREATE TABLE staging_fee_rows (
  pending_id  TEXT NOT NULL REFERENCES pending_imports(id),
  line_no     INTEGER NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('0', '3', '5', '9')),
  code        TEXT NOT NULL CHECK (length(code) = 9 AND code GLOB '4[0-9]*'),
  name        TEXT NOT NULL,
  point_kind  TEXT NOT NULL CHECK (point_kind IN ('3', '5', '6', '7', '8', '9')),
  points_x100 INTEGER NOT NULL CHECK (points_x100 >= 0),
  change_date TEXT NOT NULL CHECK (change_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date    TEXT NOT NULL CHECK (end_date = '' OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (pending_id, code)
);

-- 薬局。領収証・お薬手帳に出す情報
CREATE TABLE pharmacy_profile (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  name            TEXT NOT NULL,
  prefecture_code TEXT NOT NULL,        -- 都道府県番号（2桁）
  pharmacy_code   TEXT NOT NULL,        -- 薬局コード（7桁）
  postal_code     TEXT NOT NULL,
  address         TEXT NOT NULL,
  phone           TEXT NOT NULL
);

-- 薬局が地方厚生局に届け出た施設基準（調剤基本料の区分と加算）。届出は変わるので、適用開始日ごとに持つ。
-- 列は令和6年度・令和8年度の点数表の両方の区分を持ち、その時期に無い区分は 0 にする。
CREATE TABLE pharmacy_facility (
  valid_from        TEXT PRIMARY KEY,
  basic_fee         TEXT NOT NULL CHECK (basic_fee IN ('1', '2', '3i', '3ro', '3ha')), -- 調剤基本料の区分
  community_support INTEGER NOT NULL CHECK (community_support BETWEEN 0 AND 5), -- 地域支援体制加算（R6：1〜4）／地域支援・医薬品供給対応体制加算（R8：1〜5）
  renkei            INTEGER NOT NULL CHECK (renkei IN (0, 1)),          -- 連携強化加算
  generic_system    INTEGER NOT NULL CHECK (generic_system BETWEEN 0 AND 3), -- 後発医薬品調剤体制加算（R6 のみ）
  iryo_dx           INTEGER NOT NULL CHECK (iryo_dx BETWEEN 0 AND 3),   -- 医療ＤＸ推進体制整備加算（R6 のみ）
  iryo_joho         INTEGER NOT NULL CHECK (iryo_joho IN (0, 1)),       -- 医療情報取得加算の施設基準（R6 のみ）
  denshi_renkei     INTEGER NOT NULL CHECK (denshi_renkei IN (0, 1)),   -- 電子的調剤情報連携体制整備加算（R8 のみ）
  base_up           INTEGER NOT NULL CHECK (base_up IN (0, 1))          -- 調剤ベースアップ評価料（R8 のみ）
);

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY,
  login_id            TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  password_hash       TEXT NOT NULL,    -- PBKDF2-SHA256 の結果（16進）
  password_salt       TEXT NOT NULL,    -- ユーザーごとのランダムな塩（16進）
  password_iterations INTEGER NOT NULL
);

-- ログイン中のセッション。Cookie にはランダムなトークンを渡し、DB にはそのハッシュだけを置く。
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE patients (
  id         INTEGER PRIMARY KEY,
  patient_no TEXT NOT NULL UNIQUE,      -- 画面に出す患者番号（6桁）
  name       TEXT NOT NULL,
  kana       TEXT NOT NULL,             -- 全角カタカナ
  birth_date TEXT NOT NULL,
  sex        TEXT NOT NULL CHECK (sex IN ('M', 'F')),
  burden_percent INTEGER NOT NULL CHECK (burden_percent IN (10, 20, 30)), -- 一部負担金の割合（保険証の負担割合）
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_patients_kana ON patients(kana);

-- 処方（処方箋1枚分）
CREATE TABLE prescriptions (
  id            TEXT PRIMARY KEY,       -- サーバーで採番（明細と同じトランザクションで入れるため）
  patient_id    INTEGER NOT NULL REFERENCES patients(id),
  prescribed_on TEXT NOT NULL,          -- 処方箋の交付日
  dispensed_on  TEXT NOT NULL,          -- 調剤日。薬価と点数はこの日付で引く
  handbook      TEXT NOT NULL CHECK (handbook IN ('paper', 'electronic', 'none')), -- お薬手帳の提示（紙・電子版・なし）
  drug_points   INTEGER NOT NULL,       -- 薬剤料（選定療養の品目は保険給付の分）
  total_points  INTEGER NOT NULL,       -- 調剤技術料・薬学管理料・薬剤料・その他の合計
  burden_percent INTEGER NOT NULL,      -- 保存した時点の負担割合
  copay_yen     INTEGER NOT NULL,       -- 一部負担金（円）。合計点数 × 10円 × 負担割合 を10円未満四捨五入
  special_fee_yen INTEGER,              -- 選定療養の特別の料金（消費税込み、円）。対象の薬が無ければ NULL
  special_fee_method TEXT CHECK (special_fee_method IN ('points', 'amount')), -- 計算方法（調剤日で決まる）
  created_at    TEXT NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  CHECK (prescribed_on <= dispensed_on)
);

CREATE INDEX idx_prescriptions_patient ON prescriptions(patient_id, dispensed_on);

-- 剤（Rp）。薬剤料は剤ごとに「1日分の薬価合計 → 点数」を出すので、この単位が要る。
CREATE TABLE prescription_rps (
  id              TEXT PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  rp_no           INTEGER NOT NULL,     -- Rp1, Rp2 …
  usage           TEXT NOT NULL,        -- 用法（1日3回毎食後 など）
  rx_days         INTEGER NOT NULL CHECK (rx_days > 0), -- 処方箋に書かれた日数
  days            INTEGER NOT NULL CHECK (days > 0),    -- 調剤した日数
  days_change     TEXT CHECK (days_change IN ('inquiry', 'instruction')), -- 日数を変えた根拠：処方医への照会／処方箋の減数調剤の指示
  daily_yen       TEXT NOT NULL,        -- 1日分の薬価合計（表示用。小数第2位まで）
  points_per_day  INTEGER NOT NULL,
  points          INTEGER NOT NULL,     -- points_per_day × days
  special_points  INTEGER,              -- 選定療養の特別の料金を点数で出す期間だけ：この剤の分（1日分の点数 × 日数）
  CHECK ((days = rx_days) = (days_change IS NULL)),
  UNIQUE (prescription_id, rp_no)
);

-- 剤の中の薬。使った薬価を保存時点の値で残す（後で薬価マスタが変わっても、算定した額は変わらない）。
CREATE TABLE prescription_items (
  rp_id           TEXT NOT NULL REFERENCES prescription_rps(id),
  line_no         INTEGER NOT NULL,
  drug_code       TEXT NOT NULL REFERENCES drugs(code), -- 調剤した（渡した）薬
  daily_qty_milli INTEGER NOT NULL CHECK (daily_qty_milli > 0),
  rx_name         TEXT,                 -- 処方箋に書かれた薬（NULL＝調剤した薬と同じ）
  rx_daily_qty_milli INTEGER CHECK (rx_daily_qty_milli > 0),
  change_reason   TEXT CHECK (change_reason IN ('general', 'generic', 'inquiry')), -- 一般名処方の銘柄選択／後発品への変更調剤／照会による変更
  price_sen       INTEGER NOT NULL,     -- 調剤日時点の薬価（選定療養の品目は「保険外併用療養費の算出に用いる価格」）
  special_diff_sen INTEGER,             -- 選定療養の品目だけ：長期収載品と後発医薬品の価格差の1/2（令和8年5月までは1/4）
  CHECK ((rx_name IS NULL) = (change_reason IS NULL) AND (rx_name IS NULL) = (rx_daily_qty_milli IS NULL)),
  PRIMARY KEY (rp_id, line_no)
);

-- 疑義照会（処方医への問い合わせ）。残薬調整か、重複投薬・相互作用など（薬学的有害事象等の防止）か
CREATE TABLE inquiries (
  id              INTEGER PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  kind            TEXT NOT NULL CHECK (kind IN ('leftover', 'adverse')),
  content         TEXT NOT NULL,        -- 問い合わせた内容
  answer          TEXT NOT NULL,        -- 処方医の回答
  changed         INTEGER NOT NULL CHECK (changed IN (0, 1)), -- 処方が変わったか
  short_reason    TEXT,                 -- 残薬調整で6日分以下の変更をした理由（加算を算定するときに明細書へ書く）
  created_at      TEXT NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id)
);

-- 算定した項目（明細書の行）。薬剤料は剤ごと（prescription_rps）に持つので、ここには入れない
CREATE TABLE prescription_fees (
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  line_no         INTEGER NOT NULL,
  section         TEXT NOT NULL CHECK (section IN ('tech', 'mgmt', 'other')), -- 調剤技術料／薬学管理料／その他
  code            TEXT NOT NULL REFERENCES fee_items(code),
  name            TEXT NOT NULL,
  points          INTEGER NOT NULL,     -- 1回の点数
  count           INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (prescription_id, line_no)
);

CREATE INDEX idx_prescription_fees_code ON prescription_fees(code);

-- 患者ごとのメモ（来局をまたいで引き継ぐ情報）。分類は服薬管理指導料の通知が薬歴への記載を求める項目に合わせる。
-- 追記だけにする（消さない）。
CREATE TABLE patient_notes (
  id         INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  category   TEXT NOT NULL CHECK (category IN ('allergy', 'adverse', 'disease', 'concomitant', 'lifestyle', 'generic', 'handover')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_patient_notes_patient ON patient_notes(patient_id, created_at);

-- 来局ごとの指導記録（SOAP）。1回の来局に複数書ける（追記）。
CREATE TABLE guidance_records (
  id              INTEGER PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  subjective      TEXT NOT NULL,      -- S：患者の訴え・相談
  objective       TEXT NOT NULL,      -- O：服薬状況・検査値など
  assessment      TEXT NOT NULL,      -- A：薬剤師の評価
  plan            TEXT NOT NULL,      -- P：指導内容・次回の留意点
  leftover        TEXT NOT NULL CHECK (leftover IN ('none', 'some', 'unchecked')),   -- 残薬
  notebook        TEXT NOT NULL CHECK (notebook IN ('used', 'not_used', 'unchecked')), -- お薬手帳の活用
  created_at      TEXT NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  CHECK (subjective || objective || assessment || plan <> '')
);

CREATE INDEX idx_guidance_records_patient ON guidance_records(patient_id, created_at);

-- 誰が・いつ・どの患者の情報に触れたか
CREATE TABLE access_logs (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,             -- login / logout / patient.view / patient.create / prescription.create / note.create / record.create / master.import
  patient_id INTEGER REFERENCES patients(id),
  detail     TEXT
);

CREATE INDEX idx_access_logs_at ON access_logs(at);
CREATE INDEX idx_access_logs_patient ON access_logs(patient_id, at);
