import { z } from "zod";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";

/** 请求超时与体积护栏 */
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 40_000;
/** DDG 端点对默认 UA 常态限流，浏览器 UA 通过率高 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface WebToolOptions {
  /** 测试注入；生产用全局 fetch */
  fetch?: typeof globalThis.fetch;
}

const FetchArgs = z.object({
  url: z.string().url(),
  /** 返回文本上限（默认 40000 字符） */
  maxLength: z.number().int().positive().optional(),
});

const SearchArgs = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(8).optional(),
});

/**
 * 内网地址字面量防护（SSRF 第一层；DNS rebinding 不在 v1 范围）：
 * 拒绝 localhost / 回环 / 链路本地 / RFC1918 私网 / 元数据端点。
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h.endsWith(".localhost") ||
    /^127\./.test(h) ||
    /^0\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    h === "metadata.google.internal"
  );
}

async function readCapped(response: Response): Promise<{ buf: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { buf: Buffer.from(await response.arrayBuffer()), truncated: false };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.byteLength;
    if (total >= MAX_BODY_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return { buf: Buffer.concat(chunks), truncated };
}

function decodeBody(buf: Buffer, contentType: string): string {
  const charsetMatch = /charset=([\w-]+)/i.exec(contentType);
  const charset = charsetMatch?.[1]?.toLowerCase();
  if (charset !== undefined && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      // 未知编码回退 utf-8
    }
  }
  const text = buf.toString("utf8");
  if (charset === undefined && (text.match(/\ufffd/g) ?? []).length > 20) {
    // 中文站点常见 GBK 且不写 charset：乱码重试探一次
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return text;
    }
  }
  return text;
}

async function fetchText(
  doFetch: typeof globalThis.fetch,
  url: string,
): Promise<{ text: string; contentType: string; finalUrl: string; status: number; truncated: boolean }> {
  const response = await doFetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
  });
  const { buf, truncated } = await readCapped(response);
  const contentType = response.headers.get("content-type") ?? "text/plain";
  return {
    text: decodeBody(buf, contentType),
    contentType,
    finalUrl: response.url || url,
    status: response.status,
    truncated,
  };
}

async function htmlToReadable(html: string): Promise<string> {
  // 剥脚本/样式/注释后取正文文本（html-to-text 处理实体与块级换行）
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // @ts-expect-error html-to-text v10 的 ESM 子路径无类型声明
  const mod = (await import("html-to-text")) as unknown as {
    convert?: (html: string, opts: Record<string, unknown>) => string;
    default?: { convert: (html: string, opts: Record<string, unknown>) => string };
  };
  const convert = mod.convert ?? mod.default?.convert;
  if (convert === undefined) {
    throw new Error("html-to-text 未正确加载");
  }
  return convert(stripped, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** web_fetch：抓取 URL 并转可读文本（HTML→文本，JSON/纯文本原样，GBK 自动解码） */
export function webFetchTool(doFetch: typeof globalThis.fetch): Tool {
  return {
    definition: {
      name: "web_fetch",
      description:
        "抓取网页并转为可读文本返回（HTML 自动转正文、JSON/纯文本原样、GBK 自动处理）。" +
        "配合 web_search 使用：先搜索拿 URL 再抓取。只读。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) 地址" },
          maxLength: { type: "integer", description: "返回字符上限，默认 40000" },
        },
        required: ["url"],
      },
      readOnly: true,
    },
    async execute(input, _ctx: ToolContext): Promise<ToolOutput> {
      const parsed = FetchArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      let target: URL;
      try {
        target = new URL(parsed.data.url);
      } catch {
        return { ok: false, output: "", error: `URL 不合法: ${parsed.data.url}` };
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return { ok: false, output: "", error: "仅支持 http/https" };
      }
      if (isPrivateHost(target.hostname)) {
        return { ok: false, output: "", error: `拒绝访问内网/本机地址（SSRF 防护）: ${target.hostname}` };
      }
      try {
        const r = await fetchText(doFetch, target.toString());
        if (r.status >= 400) {
          return { ok: false, output: "", error: `HTTP ${r.status}（${target.toString().slice(0, 120)}）` };
        }
        const cap = Math.min(parsed.data.maxLength ?? MAX_OUTPUT_CHARS, MAX_OUTPUT_CHARS);
        const isHtml = /text\/html|application\/xhtml/i.test(r.contentType);
        const body = (isHtml ? await htmlToReadable(r.text) : r.text).slice(0, cap);
        if (body.trim() === "") {
          return { ok: false, output: "", error: "页面无可提取文本（可能纯脚本渲染）" };
        }
        const note =
          (r.finalUrl !== target.toString() ? `（重定向至 ${r.finalUrl.slice(0, 120)}）` : "") +
          (r.truncated ? "（正文超过 2MB 被截断）" : "");
        return { ok: true, output: `${target.toString().slice(0, 160)}${note}\n\n${body}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, output: "", error: `抓取失败: ${msg.includes("timeout") || msg.includes("Timeout") ? "超时（20s）" : msg}` };
      }
    },
  };
}

/** DDG 跳转链接解码：//duckduckgo.com/l/?uddg=<encoded> → 真实 URL */
function unwrapDdgHref(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    return uddg !== null ? decodeURIComponent(uddg) : u.toString();
  } catch {
    return href;
  }
}

/** web_search：DuckDuckGo HTML 端点搜索（无 key、尽力而为；限流时明确报错） */
export function webSearchTool(doFetch: typeof globalThis.fetch): Tool {
  return {
    definition: {
      name: "web_search",
      description:
        "联网搜索（DuckDuckGo），返回标题/链接/摘要列表；拿到链接后用 web_fetch 抓全文。中文关键词效果好。只读。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词" },
          maxResults: { type: "integer", description: "结果条数（1-8，默认 5）" },
        },
        required: ["query"],
      },
      readOnly: true,
    },
    async execute(input, _ctx: ToolContext): Promise<ToolOutput> {
      const parsed = SearchArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const max = parsed.data.maxResults ?? 5;
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(parsed.data.query)}`;
      try {
        const r = await fetchText(doFetch, url);
        if (r.status === 403 || r.status === 429) {
          return { ok: false, output: "", error: "搜索引擎限流（DuckDuckGo），请稍后再试或缩小查询" };
        }
        if (r.status >= 400) {
          return { ok: false, output: "", error: `搜索失败：HTTP ${r.status}` };
        }
        const mod = (await import("node-html-parser")) as unknown as {
          parse?: (html: string) => HtmlNode;
          default?: { parse: (html: string) => HtmlNode };
        };
        const parse = mod.parse ?? mod.default?.parse;
        if (parse === undefined) {
          return { ok: false, output: "", error: "node-html-parser 未正确加载" };
        }
        const root = parse(r.text);
        const anchors = root.querySelectorAll("a.result__a");
        if (anchors.length === 0) {
          return { ok: true, output: `（无结果：${parsed.data.query}）` };
        }
        const lines: string[] = [];
        for (const a of anchors.slice(0, max)) {
          const href = a.getAttribute("href") ?? "";
          const title = a.text.replace(/\s+/g, " ").trim();
          // 摘要在结果的 .result__snippet
          const container = a.closest(".result") ?? a.parentNode;
          const snippet = container?.querySelector(".result__snippet")?.text.replace(/\s+/g, " ").trim() ?? "";
          lines.push(`${lines.length + 1}. ${title}\n   ${unwrapDdgHref(href)}\n   ${snippet.slice(0, 200)}`);
        }
        return { ok: true, output: `搜索「${parsed.data.query}」前 ${lines.length} 条：\n\n${lines.join("\n\n")}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, output: "", error: `搜索失败: ${msg}` };
      }
    },
  };
}

/** node-html-parser 最小接口 */
interface HtmlNode {
  querySelectorAll(selector: string): HtmlNode[];
  querySelector(selector: string): HtmlNode | null;
  getAttribute(name: string): string | null;
  get text(): string;
  get parentNode(): HtmlNode | null;
  closest(selector: string): HtmlNode | null;
}

/** 会话 web 工具组（composition 注入；fetch 可测试替换） */
export function createWebTools(opts: WebToolOptions = {}): Tool[] {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return [webFetchTool(doFetch), webSearchTool(doFetch)];
}
