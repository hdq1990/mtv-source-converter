// Cloudflare Workers 不提供浏览器 TextEncoder 的 BigInt 支持，
// 自己用 BigInt 实现 Base58（与 Bitcoin 字母表一致，和 Python 版 base58_encode 等价）。
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);

  let encoded = '';
  while (num > 0n) {
    const rem = num % 58n;
    num /= 58n;
    encoded = ALPHABET[Number(rem)] + encoded;
  }

  let pad = 0;
  for (const b of bytes) {
    if (b === 0) pad++;
    else break;
  }
  return '1'.repeat(pad) + encoded;
}
