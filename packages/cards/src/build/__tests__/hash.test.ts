// 内容指纹的测试。
//
// 前三条是 FNV-1a 64 的**公开测试向量**（ASCII 输入下本实现与标准 FNV 的输入序列一致，
// 见 hash.ts 文件头对 UTF-16 那处偏离的说明）。它们的作用是：将来有人"顺手优化"
// 掉那句 `& MASK_64`、或把偏移基数抄错一位，这里立刻红 —— 而 bundleId 一旦变，
// M8 的 golden replay 就会集体失效，那时候再查代价高得多。

import { describe, expect, test } from "bun:test";
import { fingerprint, fnv1a64 } from "../hash.ts";

describe("fnv1a64 —— 公开测试向量", () => {
  test('""', () => {
    expect(fnv1a64("")).toBe(0xcbf29ce484222325n);
  });

  test('"a"', () => {
    expect(fnv1a64("a")).toBe(0xaf63dc4c8601ec8cn);
  });

  test('"foobar"', () => {
    expect(fnv1a64("foobar")).toBe(0x85944171f73967e8n);
  });
});

describe("fingerprint", () => {
  test("定长 16 位十六进制", () => {
    expect(fingerprint("foobar")).toBe("85944171f73967e8");
    expect(fingerprint("")).toHaveLength(16);
  });

  test("同输入同输出、异输入异输出（bundleId 的全部要求）", () => {
    expect(fingerprint("PF1_G01")).toBe(fingerprint("PF1_G01"));
    expect(fingerprint("PF1_G01")).not.toBe(fingerprint("PF1_G03"));
  });

  test("吃得下中文（卡面文案会进指纹）", () => {
    expect(fingerprint("新芽树裔")).toMatch(/^[0-9a-f]{16}$/);
  });
});
