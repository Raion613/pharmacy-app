// 多要素認証の6桁の数字（TOTP。RFC 6238）。スマホの認証アプリ（Google Authenticator・Microsoft Authenticator など）と同じ計算をする。
//   1. 登録のとき、サーバーとアプリで同じ「秘密」（ランダムな20バイト）を持つ。QR コードでアプリに渡す
//   2. 今の時刻を30秒ごとに区切った番号（時刻の区切り）を作る
//   3. HMAC-SHA1（秘密, 区切りの番号）を計算し、その結果から6桁の数字を取り出す（RFC 4226 の HOTP）
// サーバーとアプリは同じ秘密・同じ時刻から同じ数字を出すので、数字が合えば「秘密を持つスマホを持っている人」と分かる。
// 時計のずれを許すため、前後1区切り（±30秒）まで受け付ける。同じ区切りの数字は2回使わせない（盗み見た数字の使い回しを防ぐ）。

export const STEP_SECONDS = 30;
export const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // Base32（RFC 4648）。認証アプリは秘密をこの形で受け取る

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const s = text.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new RangeError(`Base32 に使えない文字です: ${c}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

// RFC 4226 の HOTP：HMAC-SHA1 の結果の最後の4ビットを「どこから取るか」に使い、そこから31ビットを取り出して下6桁にする
export async function hotp(secretBase32, counter) {
  const key = await crypto.subtle.importKey("raw", base32Decode(secretBase32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const stepOf = (unixMs) => Math.floor(unixMs / 1000 / STEP_SECONDS);

// 合っていれば使った区切りの番号、合わなければ null。lastStep 以下の区切りは受け付けない
export async function verifyTotp(secretBase32, code, { now = Date.now(), lastStep = null } = {}) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepOf(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (await hotp(secretBase32, step) === code) return step;
  }
  return null;
}

// 認証アプリに読ませる URI（Key Uri Format）。QR コードにして画面に出す
export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
