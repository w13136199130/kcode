#!/usr/bin/env node
/**
 * 例外登记校验（N2-5，对标 ZCode expired-exception）：
 * 1) gates-exceptions.json 每条例外带理由与到期日，过期即 fail（续期须显式改期留痕）；
 * 2) 漂移检测：.oxlintrc.json 所有 `rule: off` 的 overrides 与登记集合必须一致——
 *    配置里多出的例外（未登记）或登记里多余的条目（已失效）都算漂移；
 *    不再只校验 no-console（max-lines 等同类例外同样纳入）。
 * 3) 登记文件自身的 schema 校验（字段齐全、日期合法、期限 ≤ 一季度）。
 */
import { existsSync, readFileSync } from "node:fs";
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

// ---- 2) oxlint overrides 漂移检测（所有 rule: off 的例外 = 登记集合）----
const oxlint = JSON.parse(readFileSync(resolve(root, ".oxlintrc.json"), "utf8"));
const overrideKeys = new Set();
for (const ov of oxlint.overrides ?? []) {
  for (const [rule, value] of Object.entries(ov.rules ?? {})) {
    if (value !== "off") continue;
    for (const f of ov.files ?? []) overrideKeys.add(`${rule}|${f}`);
  }
}
const unregistered = [...overrideKeys].filter((key) => !registered.has(key));
const stale = [...registered.keys()].filter((key) => !overrideKeys.has(key));
if (unregistered.length > 0) {
  fail(`lint 例外存在未登记条目（先入 gates-exceptions.json）：${unregistered.join(", ")}`);
}
if (stale.length > 0) {
  fail(`登记中有已失效的 lint 例外（配置已移除，请清理登记）：${stale.join(", ")}`);
}

// ---- 3) DESIGN 三态化 + 文档本地链接存在（3-31）----
const checkDoc = (file) => {
  const text = readFileSync(resolve(root, file), "utf8");
  const prose = text.replace(/```[\s\S]*?```/g, ""); // 代码块里的示例链接不参与校验
  let links = 0;
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = (match[1] ?? "").trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    target = target.split("#")[0];
    if (target === "") continue;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // 非法转义按原样校验
    }
    if (!existsSync(resolve(root, decoded))) {
      fail(`${file} 的本地链接不存在：${target}`);
    }
    links += 1;
  }
  return links;
};
for (const file of ["DESIGN.md", "README.md"]) {
  checkDoc(file);
}
const designLines = readFileSync(resolve(root, "DESIGN.md"), "utf8").split("\n");
for (const [index, line] of designLines.entries()) {
  if (line.includes("已落地") && !/[✅⚠️]/.test(line)) {
    fail(`DESIGN.md:${index + 1} 声称“已落地”但未标 ✅/⚠️：${line.trim().slice(0, 80)}`);
  }
}

console.log(`✓ 例外登记校验通过：${registered.size} 条生效例外（含理由与到期日），无过期、无漂移。`);
console.log("✓ 文档对账通过：DESIGN/README 本地链接存在，“已落地”均带三态标记。");
