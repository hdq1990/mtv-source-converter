/**
 * Base58 编码（Bitcoin 字母表），输出与 Python 版 base58_encode 逐字节一致。
 *
 * ── 为什么是这个实现 ───────────────────────────────────────────────────────
 * 经典写法是「num % 58 / num /= 58」逐位取，对一份 ~8 KB 的配置需要 1 万多次
 * 大数除法。在本机实测（7876 B → 10756 字符）：
 *
 *   naive (BigInt, 每位 58)          397.7 ms
 *   BigInt 分块 58^9                 59.8 ms
 *   BigInt 分块 58^64                31.9 ms
 *   BigInt 分块 58^512 + 8 位组拆解   21.7 ms   ← 本实现
 *   32 位 limb 手写（Uint32Array）    76.7 ms   （V8 的 BigInt 比手写快得多）
 *   Number 逐字节经典算法            366.9 ms
 *
 * 也就是说：一次除法产出 512 个 base58 字符，再用 58^8（< 2^53，Number 精确）
 * 把余数拆成 8 位一组，是这里的性能甜点。21.7 ms 已经是这台机器上的平台期，
 * 512 → 4096 只会在 21.7–32.8 ms 之间波动。
 *
 * ── 为什么不放在请求路径里 ────────────────────────────────────────────────
 * Cloudflare Workers 免费套餐的 CPU 预算是 **每次调用 10 ms**（HTTP 请求和
 * Cron Trigger 都是）。21.7 ms 编一份、43 ms 编两份，放进任何一次调用都超预算。
 * 所以生产架构是：
 *   Cron（每 2h）→ 抓取 + 转换 + Base58 编码 → 写 KV
 *   请求          → 读 KV 直接返回（CPU < 1 ms）
 * 这里只保留「Cron 里用一次」和「KV 里没有时冷启动兜底算一次」两条路径。
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** 每次外层除法产出的 base58 字符数 */
const CHUNK = 512;
/** 余数拆解分组，58^8 = 128063081773558208 < 2^53，可安全放进 Number */
const GROUP = 8;

// 58^512 / 58^8 在模块初始化时算一次（微秒级），后续复用
const CHUNK_BASE = 58n ** BigInt(CHUNK);
// 58^8 = 1.28e17 < 2^53，余数转 Number 后逐位取模不会丢精度
const GROUP_BASE_BIG = 58n ** BigInt(GROUP);

export function base58Encode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const len = bytes.length;
  if (len === 0) return '';

  // 前导 0x00 字节在 base58 里表示为同等数量的 '1'
  let zeros = 0;
  while (zeros < len && bytes[zeros] === 0) zeros++;
  if (zeros === len) return '1'.repeat(zeros);

  let num = 0n;
  for (let i = 0; i < len; i++) num = (num << 8n) | BigInt(bytes[i]);

  const blocks: string[] = [];
  while (num > 0n) {
    let rem = num % CHUNK_BASE;
    num /= CHUNK_BASE;

    const digits: string[] = [];
    // rem < 58^512，按 58^8 一组往外拆，组内用 Number 取 8 个字符
    for (let produced = 0; produced < CHUNK; produced += GROUP) {
      let lo = Number(rem % GROUP_BASE_BIG);
      rem /= GROUP_BASE_BIG;
      for (let j = 0; j < GROUP; j++) {
        digits.push(ALPHABET[lo % 58]);
        lo = Math.floor(lo / 58);
      }
    }
    digits.reverse(); // 组内低位在前 → 翻成高位在前
    blocks.push(digits.join(''));
  }

  blocks.reverse(); // 块序同样是低位在前
  // 最高块可能带前导 '1'（值 0 的字符），必须去掉；真正的零字节前面已经单独补了
  blocks[0] = blocks[0].replace(/^1+/, '');

  return (zeros > 0 ? '1'.repeat(zeros) : '') + blocks.join('');
}
