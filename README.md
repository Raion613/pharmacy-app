# 薬剤料計算・薬歴

改定をまたいでも、調剤日どおりの薬価・点数で会計を出す調剤業務アプリ。

```sh
npm install
npm run db:reset
npm run dev        # http://localhost:8788（demo / pharmacy-demo）
npm test
```

データ：支払基金の基本マスター（医薬品・調剤行為）、厚労省の薬価基準・点数表、MEDIS の HOT コード、JAHIS お薬手帳仕様。アイコンは [Lucide](https://lucide.dev)（ISC）。
