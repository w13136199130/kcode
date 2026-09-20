import { readFile, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import { displayPath, resolveInCtx } from "./paths.js";

const EditArgs = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  fuzzy: z.boolean().optional(), // 默认 true：精确失败后行级模糊匹配（aider 思路，§11.B）
});

const FUZZY_THRESHOLD = 0.8;
const FUZZY_AMBIGUITY_GAP = 0.05;
const FUZZY_MIN_HEAD_SIMILARITY = 0.4;
const FUZZY_MAX_WINDOWS = 20_000;

/** edit 工具：替换文件中的文本片段（唯一精确匹配优先，失败后模糊匹配） */
export const editTool: Tool = {
  definition: {
    name: "edit",
    description:
      "替换文件中的文本片段：oldString 须在文件中唯一；精确匹配失败后自动按行模糊匹配（容忍空白差异）；执行前需用户确认",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        oldString: { type: "string", description: "待替换文本（带足上下文以保证唯一）" },
        newString: { type: "string", description: "替换后文本" },
        fuzzy: { type: "boolean", description: "默认 true，精确失败后启用模糊匹配" },
      },
      required: ["path", "oldString", "newString"],
    },
    readOnly: false,
  },
  async execute(input, ctx): Promise<{ ok: boolean; output: string; error?: string }> {
    const parsed = EditArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    const { path, oldString, newString, fuzzy } = parsed.data;
    const abs = resolveInCtx(path, ctx);

    // 工作区边界检查：工作区外的编辑返回告警，由权限确认兜底
    if (ctx.cwd !== undefined) {
      const rel = relative(ctx.cwd, abs);
      if (rel === "" || rel.split(sep)[0] === "..") {
        return { ok: false, output: "", error: `路径 ${abs} 在工作区 ${ctx.cwd} 之外，请确认是否允许` };
      }
    }

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }

    const exact = countOccurrences(content, oldString);
    if (exact === 1) {
      // replacer 用函数形式，避免 newString 中的 $& 等被当作替换元字符
      const updated = content.replace(oldString, () => newString);
      await writeFile(abs, updated, "utf8");
      return { ok: true, output: `已替换 ${displayPath(abs, ctx)}（精确匹配，1 处）` };
    }
    if (exact > 1) {
      return {
        ok: false,
        output: "",
        error: `oldString 出现 ${exact} 次，不唯一——请在 oldString 中附带更多上下文`,
      };
    }
    if (fuzzy === false) {
      return { ok: false, output: "", error: "未找到 oldString（精确匹配失败，fuzzy=false）" };
    }

    const result = fuzzyReplace(content, oldString, newString);
    if (!result.ok) {
      return { ok: false, output: "", error: result.reason };
    }
    await writeFile(abs, result.content, "utf8");
    return {
      ok: true,
      output: `已替换 ${displayPath(abs, ctx)}（模糊匹配，平均相似度 ${result.score.toFixed(2)}）`,
    };
  },
};

interface FuzzyOutcome {
  ok: boolean;
  content: string;
  score: number;
  reason?: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 行窗口模糊替换：平均行相似度最高的窗口，阈值 0.8，且与次优差距足够大 */
function fuzzyReplace(content: string, oldString: string, newString: string): FuzzyOutcome {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const fileLines = content.split(/\r?\n/);
  const oldLines = oldString.split(/\r?\n/);
  if (oldLines.length > fileLines.length) {
    return { ok: false, content: "", score: 0, reason: "oldString 行数超过文件行数" };
  }

  let bestIndex = -1;
  let bestScore = 0;
  let runnerUp = 0;
  const limit = Math.min(fileLines.length - oldLines.length, FUZZY_MAX_WINDOWS);
  for (let i = 0; i <= limit; i++) {
    // 快速预筛：首行相似度过低直接跳过，控制 levenshtein 计算量
    if (
      oldLines.length > 2 &&
      similarity(fileLines[i] ?? "", oldLines[0] ?? "") < FUZZY_MIN_HEAD_SIMILARITY
    ) {
      continue;
    }
    let total = 0;
    for (let j = 0; j < oldLines.length; j++) {
      total += similarity(fileLines[i + j] ?? "", oldLines[j] ?? "");
    }
    const score = total / oldLines.length;
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      bestIndex = i;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (bestIndex < 0 || bestScore < FUZZY_THRESHOLD) {
    return {
      ok: false,
      content: "",
      score: bestScore,
      reason: `未找到匹配（最佳平均相似度 ${bestScore.toFixed(2)} < ${FUZZY_THRESHOLD}）`,
    };
  }
  if (runnerUp >= FUZZY_THRESHOLD && bestScore - runnerUp < FUZZY_AMBIGUITY_GAP) {
    return {
      ok: false,
      content: "",
      score: bestScore,
      reason: "存在多个相近的模糊匹配窗口，结果有歧义——请在 oldString 中附带更多上下文",
    };
  }

  const replaced = [
    ...fileLines.slice(0, bestIndex),
    ...newString.split(/\r?\n/),
    ...fileLines.slice(bestIndex + oldLines.length),
  ];
  return { ok: true, content: replaced.join(eol), score: bestScore };
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(prev[j]! + 1, current[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = current;
  }
  return prev[b.length]!;
}
