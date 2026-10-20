import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistImages } from "../src/session.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-image-persist-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("3-02 图片持久化", () => {
  it("复制进会话 artifacts，原图删除后仍可用，同内容去重", async () => {
    const source = join(root, "shot.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await writeFile(source, bytes);
    const home = join(root, "home");
    const [saved] = await persistImages([source], home, "sess_img");
    expect(saved).toBeDefined();
    expect(saved!.startsWith(join(home, "cli", "artifacts", "images", "sess_img"))).toBe(true);
    expect(await readFile(saved!)).toEqual(bytes);

    const [again] = await persistImages([source], home, "sess_img");
    expect(again).toBe(saved);

    await unlink(source);
    expect(await readFile(saved!)).toEqual(bytes);
  });

  it("源图不存在时给出可操作错误", async () => {
    await expect(
      persistImages([join(root, "missing.png")], join(root, "home2"), "s"),
    ).rejects.toThrow(/读取附图失败/);
  });
});
