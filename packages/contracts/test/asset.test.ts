import { describe, expect, it } from "vitest";
import { AssetRef, ASSET_EXT_BY_MIME, ASSET_MIME_ALLOWLIST } from "../src/asset.js";

/** S2-2 契约步：AssetRef 引用校验（设计稿 docs/asset-contract-design.md §1/§5）。 */
describe("AssetRef（S2-2）", () => {
  it("合法引用通过", () => {
    const parsed = AssetRef.safeParse({
      id: "ar_9f8e7d6c5b4a",
      path: "sess_abc/ar_9f8e7d6c5b4a.png",
      mime: "image/png",
      meta: { bytes: 1024, width: 800, height: 600, source: "dialog" },
    });
    expect(parsed.success).toBe(true);
  });

  it("id 必须命中 ar_ 前缀与长度约束", () => {
    for (const id of ["img_12345678", "ar_short", "ar_九八七六五四三二", "ar_9f8e7d6c5b4a"]) {
      const ok = AssetRef.safeParse({ id, path: "a/b.png", mime: "image/png" }).success;
      expect(ok).toBe(id === "ar_9f8e7d6c5b4a");
    }
  });

  it("path 禁反斜杠/../盘符（存储内相对路径）", () => {
    for (const path of ["a\\b.png", "../escape.png", "C:/abs.png", "a/../../x.png"]) {
      expect(AssetRef.safeParse({ id: "ar_9f8e7d6c5b4a", path, mime: "image/png" }).success).toBe(false);
    }
    expect(AssetRef.safeParse({ id: "ar_9f8e7d6c5b4a", path: "sess/ar.png", mime: "image/png" }).success).toBe(true);
  });

  it("mime 白名单前缀外的值拒绝；meta 字段类型校验", () => {
    expect(AssetRef.safeParse({ id: "ar_9f8e7d6c5b4a", path: "a.mp4", mime: "video/mp4" }).success).toBe(true); // 契约层放行 video 前缀（实现步按阶段白名单收紧）
    expect(AssetRef.safeParse({ id: "ar_9f8e7d6c5b4a", path: "a.exe", mime: "application/octet-stream" }).success).toBe(false);
    expect(
      AssetRef.safeParse({ id: "ar_9f8e7d6c5b4a", path: "a.png", mime: "image/png", meta: { width: -1 } }).success,
    ).toBe(false);
  });

  it("第一批 mime 白名单与扩展名映射一致", () => {
    for (const mime of ASSET_MIME_ALLOWLIST) {
      expect(ASSET_EXT_BY_MIME[mime]).toBeDefined();
    }
    expect(Object.keys(ASSET_EXT_BY_MIME)).toHaveLength(ASSET_MIME_ALLOWLIST.length);
  });
});
