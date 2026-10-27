import { z } from "zod";

/**
 * 资产引用契约（S2-2 设计稿第一步：只定义引用，存储/RPC 在评审后实现。
 * 设计见 docs/asset-contract-design.md）。
 *
 * 引用与所有权分离：AssetRef 只出现在事件/消息里；文件本体归 host 资产存储，
 * renderer 不接触绝对路径（preload IPC 冻结原则）。
 */
export const ASSET_ID = /^ar_[a-z0-9]{8,24}$/;

export const AssetRef = z.object({
  /** 进程内生成（crypto），非内容 hash——去重是素材库阶段的事 */
  id: z.string().regex(ASSET_ID),
  /** 存储内相对路径（正斜杠，无 ..、无盘符、无反斜杠）——整个 store 可搬迁 */
  path: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !value.includes("\\") && !value.includes("..") && !/^[a-z]+:/i.test(value), {
      message: "资产路径必须是存储内相对路径（禁反斜杠/../盘符）",
    }),
  mime: z.string().regex(/^(image|video|application\/pdf|text)\//, "mime 不在白名单前缀内"),
  meta: z
    .object({
      bytes: z.number().int().nonnegative().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      durationMs: z.number().int().nonnegative().optional(),
      source: z.enum(["dialog", "tool", "generated", "canvas"]).optional(),
    })
    .optional(),
});
export type AssetRef = z.infer<typeof AssetRef>;

/** 第一批 mime 白名单（与桌面 pickImages 过滤器一致；video/pdf 随能力阶段放开） */
export const ASSET_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** 单文件/单会话容量默认（env KCODE_ASSET_MAX_BYTES / KCODE_ASSET_MAX_COUNT 覆盖；实现步接线） */
export const ASSET_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const ASSET_DEFAULT_MAX_COUNT = 200;

/** mime → 存储扩展名（调用方不可指定扩展名，防双扩展） */
export const ASSET_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
