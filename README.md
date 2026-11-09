# 薬剤料計算・薬歴

薬価・調剤報酬の改定をまたいで、調剤日どおりの会計を出す調剤業務 Web アプリ。薬価と点数は支払基金の基本マスター（実データ）。

- 紹介資料：[docs/紹介資料.pptx](./docs/紹介資料.pptx)
- デモ用アカウント：`demo` ／ `pharmacy-demo`（患者はすべて架空）

## 起動

Node.js 24。

```sh
npm install
npm run db:reset
npm run dev        # http://localhost:8788
```

## テスト

```sh
npm test
npm run e2e        # db:reset 直後、dev を起動した状態で（Edge）
```

## データの出典

- 医療情報基盤・診療報酬審査支払機構「基本マスター」[医薬品マスター](https://www.hpdx.or.jp/smph/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.html)・[調剤行為マスター](https://www.hpdx.or.jp/smph/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_03.html)
- 厚生労働省「[令和8年度診療報酬改定について](https://www.mhlw.go.jp/stf/newpage_67729.html)」「[長期収載品の選定療養について](https://www.mhlw.go.jp/stf/newpage_39830.html)」「薬価基準収載品目リスト」
- MEDIS「[医薬品HOTコードマスター](https://www2.medis.or.jp/hcode/)」
- PMDA 添付文書（小児の用量）
- JAHIS「電子版お薬手帳データフォーマット仕様書 Ver.2.0」
- アイコン：[Lucide](https://lucide.dev)（ISC License）
