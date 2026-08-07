// RNG 的守门测试（框架 §4.3、架构 §6.1）。
//
// 这些断言守的是三样东西，坏了任何一样，「{seed, deckLists, intents[]} 复现一局」
// 就不再成立：
//   1. **同种子同流** —— 回放的地基。含一条黄金向量：算法被人换掉必红。
//   2. **纯数据 / JSON 往返** —— 架构 §6.1 第二条测试对 RngState 这一块的提前落点。
//   3. **均匀无偏** —— 洗牌、随机目标、随机发现的公平性。
//
// 另有一条 BigInt 参考实现的交叉验证：它完全不用 `Math.imul` / `<<` / `>>>`，
// 只用 BigInt 与掩码重写一遍 xoroshiro64**，用来钉死「32 位截断写对了」——
// 这正是跨平台逐位一致的前提（rng.ts 文件头「跨平台一致性」第 2 条）。

import { describe, expect, test } from "bun:test";
import type { HasRng, RngState } from "../index.ts";
import { createRngState, NEXT_INT_MAX_BOUND, nextInt } from "../index.ts";

/** `nextInt` 按框架签名收的是「带 rng 字段的状态」，测试里用最小容器代替 GameState。 */
function box(seed: number): { rng: RngState } {
  return { rng: createRngState(seed) };
}

/** 连抽 n 个 `[0, bound)` 的数。 */
function draws(state: HasRng, n: number, bound: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(nextInt(state, bound));
  return out;
}

/** 抽 n 次，统计每个桶的次数。 */
function buckets(seed: number, bound: number, n: number): number[] {
  const state = box(seed);
  const counts = new Array<number>(bound).fill(0);
  for (let i = 0; i < n; i++) {
    const k = nextInt(state, bound);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// 架构 §6.1 两条确定性测试用的就是这个种子，这里沿用，方便日后对照。
const SEED = 0x9f1;

describe("确定性：同种子同流", () => {
  test("同一种子的两条流逐个取值一致，末态也一致", () => {
    const a = box(SEED);
    const b = box(SEED);
    expect(draws(a, 1000, 1000)).toEqual(draws(b, 1000, 1000));
    expect(a.rng).toEqual(b.rng);
  });

  test("不同种子立刻发散（相邻种子也不例外）", () => {
    const firsts = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => nextInt(box(s), NEXT_INT_MAX_BOUND));
    expect(new Set(firsts).size).toBe(8);

    // 播种走 splitmix32 的意义：seed 与 seed+1 不是"错一位"的关系，而是彻底无关的两条流。
    const near = draws(box(12345), 50, NEXT_INT_MAX_BOUND);
    const next = draws(box(12346), 50, NEXT_INT_MAX_BOUND);
    expect(near).not.toEqual(next);
    expect(near.filter((v, i) => v === next[i])).toHaveLength(0);
  });

  test("黄金向量：seed 0x9F1 的初态与前 8 个原始字被钉死", () => {
    // ⚠️ 这条测试的意义就是"不许变"。它红了只有两种情况：
    //    (a) 有人换了算法或播种方式 —— 那么所有历史回放全部失真，属于破坏性变更，
    //        必须同步作废旧回放，不能只改这里的期望值；
    //    (b) 某个 JS 引擎的 32 位整数语义与规范不符 —— 那是引擎 bug。
    expect(createRngState(SEED)).toEqual({ s0: 39764544, s1: 2370836937 });
    expect(draws(box(SEED), 8, NEXT_INT_MAX_BOUND)).toEqual([
      2098657400, 378417152, 4144009662, 3321073112, 3826915839, 4253612502, 1482203263, 45050088,
    ]);
  });
});

describe("纯数据：JSON 往返（框架 §3.1、§13 坑 3）", () => {
  test("RngState 只有 s0/s1 两个无符号整数字段", () => {
    const state = box(SEED);
    draws(state, 37, 7); // 先推进一段，避开只测初态的假绿
    expect(Object.keys(state.rng).sort()).toEqual(["s0", "s1"]);
    for (const v of [state.rng.s0, state.rng.s1]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(NEXT_INT_MAX_BOUND);
    }
  });

  test("往返后逐字段相等，且序列化文本稳定（无符号规范形式）", () => {
    const state = box(SEED);
    draws(state, 100, 52);
    const text = JSON.stringify(state.rng);
    const revived = JSON.parse(text) as RngState;
    expect(revived).toEqual(state.rng);
    expect(JSON.stringify(revived)).toBe(text);
    expect(text).not.toContain("-"); // 位运算漏掉 >>> 0 就会在这里现形
  });

  test("往返后继续推进，与不往返完全一致", () => {
    const live = box(SEED);
    draws(live, 64, 6);
    const revived: { rng: RngState } = { rng: JSON.parse(JSON.stringify(live.rng)) as RngState };
    expect(draws(live, 256, 1000)).toEqual(draws(revived, 256, 1000));
    expect(live.rng).toEqual(revived.rng);
  });
});

describe("算法正确性：与 BigInt 参考实现逐位一致", () => {
  test("xoroshiro64** 的 500 步输出与状态全部吻合", () => {
    const MASK = (1n << 32n) - 1n;
    const rotl = (x: bigint, k: bigint): bigint => ((x << k) & MASK) | (x >> (32n - k));
    const refNext = (st: { s0: bigint; s1: bigint }): bigint => {
      const s0 = st.s0;
      let s1 = st.s1;
      const result = (rotl((s0 * 0x9e3779bbn) & MASK, 5n) * 5n) & MASK;
      s1 ^= s0;
      st.s0 = (rotl(s0, 26n) ^ s1 ^ ((s1 << 9n) & MASK)) & MASK;
      st.s1 = rotl(s1, 13n);
      return result;
    };

    const live = box(20260807);
    const ref = { s0: BigInt(live.rng.s0), s1: BigInt(live.rng.s1) };
    for (let i = 0; i < 500; i++) {
      const got = nextInt(live, NEXT_INT_MAX_BOUND);
      expect(BigInt(got)).toBe(refNext(ref));
      expect(BigInt(live.rng.s0)).toBe(ref.s0);
      expect(BigInt(live.rng.s1)).toBe(ref.s1);
    }
  });
});

describe("播种：createRngState", () => {
  test("拒收非安全整数种子（确定性代码不接受 NaN）", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53)]) {
      expect(() => createRngState(bad)).toThrow(/安全整数/);
    }
  });

  test("负种子与超过 2^32 的种子都收得下", () => {
    for (const seed of [-1, -(2 ** 31), 2 ** 32, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      const rng = createRngState(seed);
      expect(Number.isInteger(rng.s0)).toBe(true);
      expect(Number.isInteger(rng.s1)).toBe(true);
    }
  });

  test("种子的全部 53 位都参与：翻任意一位都换一条流", () => {
    // 这条守的是 createRngState 里那句「M9 应当生成满 53 位的随机种子」——
    // 如果播种把种子先折成 32 位，第 32 位以上的翻转会静默无效，可达流的数量
    // 掉到 2^32，攻击者对着几个已下发的随机结果就能反推种子（框架 §4.3 隐藏信息）。
    const baseSeed = 0x0f_0f0f_0f0f;
    const baseState = createRngState(baseSeed);
    const seen = new Set<string>([`${baseState.s0},${baseState.s1}`]);
    for (let bit = 0; bit < 53; bit++) {
      const weight = 2 ** bit;
      const isSet = Math.floor(baseSeed / weight) % 2 === 1;
      const rng = createRngState(isSet ? baseSeed - weight : baseSeed + weight);
      expect(rng).not.toEqual(baseState);
      seen.add(`${rng.s0},${rng.s1}`);
    }
    expect(seen.size).toBe(54); // 54 个种子 → 54 条互不相同的流
  });

  test("十万个连续种子两两不同，且永不落到禁用状态 (0,0)", () => {
    // Feistel 是双射，`s1 | 1` 至多把它退化成 2 对 1，所以连续种子必然全不相同。
    const seen = new Set<string>();
    for (let seed = -50_000; seed < 50_000; seed++) {
      const rng = createRngState(seed);
      expect(rng.s0 === 0 && rng.s1 === 0).toBe(false);
      expect(rng.s1 % 2).toBe(1); // s1 钉成奇数 = 结构性排除 (0,0)，见 createRngState 说明
      seen.add(`${rng.s0},${rng.s1}`);
    }
    expect(seen.size).toBe(100_000);
  });
});

describe("nextInt 的契约", () => {
  test("取值恒落在 [0, max)，上界取不到", () => {
    for (const bound of [1, 2, 3, 5, 6, 7, 9, 10, 52, 1000]) {
      const state = box(bound);
      for (const v of draws(state, 2000, bound)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(bound);
      }
    }
  });

  test("max=1 恒为 0，但照样消耗一个字（推进次数与分支无关）", () => {
    const a = box(7);
    const b = box(7);
    expect(draws(a, 10, 1)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    draws(b, 10, NEXT_INT_MAX_BOUND);
    expect(a.rng).toEqual(b.rng);
  });

  test("max=2^32 直接返回原始字（拒绝采样此时恒不触发）", () => {
    const state = box(1);
    const values = draws(state, 200, NEXT_INT_MAX_BOUND);
    for (const v of values) expect(v).toBeLessThan(NEXT_INT_MAX_BOUND);
    expect(new Set(values).size).toBe(200); // 32 位空间里 200 个字撞车的概率 ~ 4.6e-6
  });

  test("非法 max 抛错，且抛错前不推进状态", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, NEXT_INT_MAX_BOUND + 1]) {
      const state = box(3);
      const before = { ...state.rng };
      expect(() => nextInt(state, bad)).toThrow(/max/);
      expect(state.rng).toEqual(before);
    }
  });
});

describe("取模偏置：拒绝采样", () => {
  test("与手写的拒绝采样参考实现逐个吻合，且确实发生了拒绝", () => {
    // max = 3·2^30：limit = 3·2^30，2^32 里有整整 25% 的字要被丢掉 —— 拒绝分支必被覆盖。
    // 朴素的 x % max 在这里会让前 1/3 的取值多出现 33%，本测试就是那条路的反证。
    const BIASED_BOUND = 3 * 2 ** 30;
    const actual = box(42);
    const reference = box(42);

    let rawDraws = 0;
    const expected: number[] = [];
    for (let i = 0; i < 500; i++) {
      let x: number;
      do {
        x = nextInt(reference, NEXT_INT_MAX_BOUND); // 原始字
        rawDraws++;
      } while (x >= BIASED_BOUND);
      expected.push(x % BIASED_BOUND);
    }

    expect(draws(actual, 500, BIASED_BOUND)).toEqual(expected);
    expect(actual.rng).toEqual(reference.rng); // 连推进步数都一致
    expect(rawDraws).toBeGreaterThan(500); // 真的拒绝过（期望 ≈ 667）
    expect(rawDraws).toBeLessThan(1000); // 期望消耗 < 2 个字
  });

  test("小 max 的分布不偏斜（每桶落在 4σ 内）", () => {
    // 阈值取二项分布的 4σ 而不是拍脑袋的百分比：σ = √(n·p·(1−p))。
    // 测试是确定性的（种子写死），4σ 只是说明「这个偏差属于正常涨落」的度量。
    const cases: ReadonlyArray<readonly [number, number]> = [
      [2, 100_000],
      [3, 60_000],
      [6, 60_000],
      [7, 70_000],
      [52, 260_000],
    ];
    for (const [bound, n] of cases) {
      const expectedPerBucket = n / bound;
      const sigma = Math.sqrt(n * (1 / bound) * (1 - 1 / bound));
      for (const count of buckets(bound * 11, bound, n)) {
        expect(Math.abs(count - expectedPerBucket)).toBeLessThan(4 * sigma);
      }
    }
  });

  test("Fisher-Yates 洗 5 张牌：120 种排列全部出现且分布均匀", () => {
    // 洗牌是本项目唯一天天用到的随机点（《调研报告》：Foundry 除洗牌外几乎没有随机），
    // 这条把 nextInt 放进真实用法里验一遍：bound 逐次变小 5→4→3→2→1，最易暴露边界错误。
    const state = box(2024);
    const seen = new Map<string, number>();
    const rounds = 60_000;
    for (let i = 0; i < rounds; i++) {
      const pool = [0, 1, 2, 3, 4];
      const order: number[] = [];
      while (pool.length > 0) {
        const [picked] = pool.splice(nextInt(state, pool.length), 1);
        if (picked !== undefined) order.push(picked);
      }
      const key = order.join("");
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect(seen.size).toBe(120);
    const expectedPerPerm = rounds / 120;
    for (const count of seen.values()) {
      expect(Math.abs(count - expectedPerPerm)).toBeLessThan(expectedPerPerm * 0.25);
    }
  });
});

describe("接口形状", () => {
  test("只读 rng 字段的状态也能直接传给 nextInt（HasRng 的结构约束）", () => {
    // GameState 的 rng 字段将来无论声明成 readonly 还是可写，都满足 HasRng：
    // nextInt 只改 rng 内部的两个字段，从不替换 state.rng 本身。
    const frozenShape: { readonly rng: RngState } = { rng: createRngState(9) };
    const v = nextInt(frozenShape, 10);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(10);

    // 而且推进的确实是同一个对象（引用语义，不是复制）。
    const alias: RngState = frozenShape.rng;
    nextInt(frozenShape, 100);
    expect(alias).toEqual(frozenShape.rng);
  });
});
