#!/usr/bin/env node
/**
 * 例外登记校验（N2-5，对标 ZCode expired-exception）：
 * 1) gates-exceptions.json 每条例外带理由与到期日，过期即 fail（续期须显式改期留痕）；
 * 2) 漂移检测：.oxlintrc.json 的 no-console 白名单与登记集合必须一致——
 *    配置里多出的例外（未登记）或登记里多余的条目（已失效）都算漂移；
 * 3) 登记文件自身的 schema 校验（字段齐全、日期合法、期限 ≤ 一季度）。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// ---- 1) 登记文件 schema + 到期 ----
const registry = JSON.parse(readFileSync(resolve(root, "gates-exceptions.json"), "utf8"));
if (registry.version !== 1) fail(`未知登记版本 ${registry.version}`);
const today = new Date();
const quarterAhead = new Date(today);
quarterAhead.setMonth(quarterAhead.getMonth() + 3);

const registered = new Map(); // "rule|file" → expires
for (const entry of registry.entries ?? []) {
  for (const field of ["rule", "files", "reason", "expires"]) {
    if (entry[field] === undefined) fail(`登记条目缺字段 ${field}：${JSON.stringify(entry)}`);
  }
  const exp = new Date(entry.expires);
  if (Number.isNaN(exp.getTime())) fail(`登记到期日非法：${entry.expires}`);
  if (exp < today) fail(`例外已过期（${entry.expires}）——修复或显式续期改期：${entry.rule} ${entry.files.join(",")}`);
  if (exp > quarterAhead) fail(`例外期限超出一季度上限（${entry.expires}）：${entry.rule}——长期例外须拆解根因而非续期`);
  for (const file of entry.files) {
    registered.set(`${entry.rule}|${file}`, entry.expires);
  }
}

// ---- 2) oxlint overrides 漂移检测（no-console 白名单 = 登记集合）----
const oxlint = JSON.parse(readFileSync(resolve(root, ".oxlintrc.json"), "utf8"));
const overrideFiles = new Set();
for (const ov of oxlint.overrides ?? []) {
  if (Object.keys(ov.rules ?? {}).includes("no-console") && ov.rules["no-console"] === "off") {
    for (const f of ov.files ?? []) overrideFiles.add(f);
  }
}
const registeredFiles = new Set();
for (const [key] of registered) {
  if (key.startsWith("no-console|")) registeredFiles.add(key.slice("no-console|".length));
}
const unregistered = [...overrideFiles].filter((f) => !registeredFiles.has(f));
const stale = [...registeredFiles].filter((f) => !overrideFiles.has(f));
if (unregistered.length > 0) {
  fail(`no-console 白名单存在未登记条目（先入 gates-exceptions.json）：${unregistered.join(", ")}`);
}
if (stale.length > 0) {
  fail(`登记中有已失效的 no-console 例外（配置已移除，请清理登记）：${stale.join(", ")}`);
}

console.log(`✓ 例外登记校验通过：${registered.size} 条生效例外（含理由与到期日），无过期、无漂移。`);
