// M11 反向断言：引擎源码不得读取卡牌归属元数据。

import { expect, test } from "bun:test";

declare const Bun: {
  readonly Glob: new (
    pattern: string,
  ) => {
    scanSync(options: { readonly cwd: string; readonly absolute: true }): string[];
  };
  file(path: string): { text(): Promise<string> };
  readonly cwd: string;
};

// 卡牌归属字段的等价访问形式：data.hero / data?.hero / (data).hero / data["hero"] / data['hero']。
// 注释行会被过滤，所以这里不会误报文档里"绝不读 data.hero"之类的警告注释。
const ownershipAccess =
  /\bdata\s*\?*\.\s*hero\b|\(\s*data\s*\)\s*\.\s*hero\b|\bdata\s*\[\s*["']hero["']\s*\]/;

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
};

async function findOwnershipAccess(directory: string): Promise<string[]> {
  const matches: string[] = [];
  for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: directory, absolute: true })) {
    const lines = (await Bun.file(path).text()).split("\n");
    for (const [index, line] of lines.entries()) {
      if (!isCommentLine(line) && ownershipAccess.test(line)) {
        matches.push(`${path}:${index + 1}`);
      }
    }
  }
  return matches;
}

test("引擎源码不得读取卡牌归属字段", async () => {
  // 卡牌归属是构筑层元数据；英雄选择动作中的同名字段不属于此禁令。
  const engineDirectory = Bun.cwd.endsWith("/packages/engine")
    ? Bun.cwd
    : `${Bun.cwd}/packages/engine`;
  const matches = await findOwnershipAccess(`${engineDirectory}/src`);

  expect(matches).toEqual([]);
});

test("守卫正则能抓住归属字段的等价访问形式", () => {
  // 拼接写法：这些样本本身会被本测试的文件扫描命中，字面量写出来等于自爆。
  const violations = [
    "data" + ".hero",
    "data?." + "hero",
    "data . " + "hero",
    "(data)" + ".hero",
    'data["he' + 'ro"]',
    "data['he" + "ro']",
    "const h = data?." + "hero ?? other;",
  ];
  for (const line of violations) expect(ownershipAccess.test(line)).toBe(true);
});

test("守卫正则放过合法用法", () => {
  const legal = [
    "pick.hero",
    "other.hero === pick.hero",
    "heroId",
    "data.heroId",
    "data.kind",
    "entity.data.kind",
  ];
  for (const line of legal) expect(ownershipAccess.test(line)).toBe(false);
});
