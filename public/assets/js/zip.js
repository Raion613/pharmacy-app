// ZIP の中のファイルを取り出す。支払基金の全件ファイル（y_ALL….zip）を読むためだけの最小限。
// ZIP の末尾にある目次（中央ディレクトリ）を読み、deflate で圧縮された中身を標準の DecompressionStream で展開する。
// ブラウザ（取り込み画面）と Node（初期データの作成・テスト）で同じものを使う。

// 利用者に見せる読み込みの失敗（壊れたファイル・ZIP 以外）
export class FileFormatError extends Error {}

// ファイル名 → 中身（Uint8Array）を返す関数の入った目次を返す
export function openZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 目次の終わりの印（EOCD）。後ろに最大 65535 バイトのコメントが付けられるので、後ろから探す
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new FileFormatError("ZIP ファイルではありません");

  const decoder = new TextDecoder();
  const entries = new Map();
  let p = view.getUint32(end + 16, true);
  for (let k = view.getUint16(end + 10, true); k > 0; k--) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new FileFormatError("ZIP ファイルが壊れています");
    const nameLength = view.getUint16(p + 28, true);
    entries.set(decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)), {
      method: view.getUint16(p + 10, true), // 0 = そのまま、8 = deflate 圧縮
      size: view.getUint32(p + 20, true),   // 圧縮後の大きさ
      header: view.getUint32(p + 42, true), // 各ファイルの前に付く見出しの位置
    });
    p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }

  return {
    names: [...entries.keys()],
    async read(name) {
      const e = entries.get(name);
      const start = e.header + 30 + view.getUint16(e.header + 26, true) + view.getUint16(e.header + 28, true);
      const data = bytes.subarray(start, start + e.size);
      if (e.method === 0) return data;
      if (e.method !== 8) throw new FileFormatError("対応していない圧縮形式の ZIP です");
      try {
        return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      } catch (cause) {
        // 展開の失敗は、ファイルが壊れていることを利用者に伝える
        if (cause instanceof TypeError) throw new FileFormatError("ZIP ファイルが壊れています");
        throw cause;
      }
    },
  };
}
