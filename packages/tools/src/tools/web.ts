import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";

/** 请求超时与体积护栏；模型 token 预算由 loop 层 capToolResult 负责 */
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 40_000;
/** DDG 端点对默认 UA 常态限流，浏览器 UA 通过率高 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface WebToolOptions {
  /** 测试注入；生产用全局 fetch */
  fetch?: typeof globalThis.fetch;
  /** 搜索后端来源 env（测试注入；默认 process.env） */
  env?: NodeJS.ProcessEnv;
  /** DNS 解析（测试注入；默认 node:dns） */
  lookup?: LookupFn;
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

type LookupAddress = { address: string; family: number };
type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

/** 内网/保留地址判定（字面量 + DNS 解析后都复用这一份） */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(raw: string): boolean {
  const ip = raw.toLowerCase();
  if (ip === "::" || ip === "::1") return true;
  // IPv4-mapped：::ffff:127.0.0.1
  if (ip.startsWith("::ffff:")) return isPrivateIpv4(ip.slice("::ffff:".length));
  // link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
  // unique local fc00::/7
  if (/^f[cd][0-9a-f]{0,2}:/.test(ip)) return true;
  return false;
}

/** 字面量/域名粗检；IP 一律走精确判定，域名再做 DNS 后的 IP 校验 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    return true;
  }
  const family = isIP(h);
  if (family === 4) return isPrivateIpv4(h);
  if (family === 6) return isPrivateIpv6(h);
  return false;
}

/** 2-15：每个跳转都解析并校验全部 A/AAAA，任一私网即拒绝（fail-closed） */
async function assertPublicHost(hostname: string, lookup: LookupFn): Promise<void> {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateHost(h)) {
    throw new Error(`拒绝访问内网/本机地址（SSRF 防护）: ${hostname}`);
  }
  if (isIP(h) !== 0) return;
  const addresses = await lookup(h);
  if (addresses.length === 0) {
    throw new Error(`域名无法解析（SSRF 防护 fail-closed）: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateHost(address)) {
      throw new Error(`域名解析到内网地址（SSRF 防护）: ${hostname} → ${address}`);
    }
  }
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

const defaultLookup: LookupFn = async (hostname) => {
  const entries = await dnsLookup(hostname, { all: true });
  return entries.map((e) => ({ address: e.address, family: e.family }));
};

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** 2-15：web_fetch 专用——manual 重定向逐跳复检，禁止 302 → 127.0.0.1 */
async function fetchWithRedirectGuard(
  doFetch: typeof globalThis.fetch,
  rawUrl: string,
  lookup: LookupFn,
): Promise<{ response: Response; finalUrl: string }> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error(`URL 不合法: ${rawUrl}`);
  }
  for (let hop = 0; hop <= 5; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("仅支持 http/https");
    }
    await assertPublicHost(current.hostname, lookup);
    const response = await doFetch(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
    });
    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get("location");
      if (location !== null) {
        await response.body?.cancel();
        current = new URL(location, current);
        continue;
      }
    }
    return { response, finalUrl: current.toString() };
  }
  throw new Error("重定向次数过多（>5）");
}

async function fetchText(
  doFetch: typeof globalThis.fetch,
  url: string,
  opts: { safe?: boolean; lookup?: LookupFn } = {},
): Promise<{ text: string; contentType: string; finalUrl: string; status: number; truncated: boolean }> {
  const safeResult =
    opts.safe === true ? await fetchWithRedirectGuard(doFetch, url, opts.lookup ?? defaultLookup) : null;
  const response =
    safeResult?.response ??
    (await doFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
    }));
  const { buf, truncated } = await readCapped(response);
  const contentType = response.headers.get("content-type") ?? "text/plain";
  return {
    text: decodeBody(buf, contentType),
    contentType,
    finalUrl: safeResult?.finalUrl ?? (response.url || url),
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
export function webFetchTool(doFetch: typeof globalThis.fetch, lookup: LookupFn = defaultLookup): Tool {
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
      permission: { default: "allow" },
      timeoutMs: 60_000,
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
        const r = await fetchText(doFetch, target.toString(), { safe: true, lookup });
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

/** 搜索后端（N3F-8）：KCODE_SEARCH 白名单 duckduckgo|searxng|none；默认 DDG 本地免 key */
export type SearchBackend = { kind: "duckduckgo" } | { kind: "searxng"; base: string } | { kind: "none" };

/** 解析搜索后端配置：非法值/缺实例 URL 当场抛错（fail-fast，与 --mode 同哲学） */
export function resolveSearchBackend(env: NodeJS.ProcessEnv = process.env): SearchBackend {
  const value = (env["KCODE_SEARCH"] ?? "").trim().toLowerCase();
  if (value === "" || value === "duckduckgo") {
    return { kind: "duckduckgo" };
  }
  if (value === "none") {
    return { kind: "none" };
  }
  if (value === "searxng") {
    const base = (env["KCODE_SEARXNG_URL"] ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(base)) {
      throw new Error("KCODE_SEARCH=searxng 需要 KCODE_SEARXNG_URL 指定实例地址（如 https://searx.example.org）");
    }
    return { kind: "searxng", base };
  }
  throw new Error(`KCODE_SEARCH 只能是 duckduckgo | searxng | none（收到 "${value}"）`);
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
export function webSearchTool(doFetch: typeof globalThis.fetch, backend: SearchBackend = { kind: "duckduckgo" }): Tool {
  return {
    definition: {
      name: "web_search",
      description:
        "联网搜索（后端可配 KCODE_SEARCH：默认 DuckDuckGo，可切自建 SearXNG），返回标题/链接/摘要列表；拿到链接后用 web_fetch 抓全文。中文关键词效果好。只读。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词" },
          maxResults: { type: "integer", description: "结果条数（1-8，默认 5）" },
        },
        required: ["query"],
      },
      readOnly: true,
      permission: { default: "allow" },
      timeoutMs: 60_000,
    },
    async execute(input, _ctx: ToolContext): Promise<ToolOutput> {
      const parsed = SearchArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const max = parsed.data.maxResults ?? 5;
      if (backend.kind === "searxng") {
        return searchSearxng(doFetch, backend.base, parsed.data.query, max);
      }
      return searchDdg(doFetch, parsed.data.query, max);
    },
  };
}

/** SearXNG JSON API（自建实例信任其配置；实例地址来自 env 不经模型输入，无 SSRF 面扩大） */
async function searchSearxng(
  doFetch: typeof globalThis.fetch,
  base: string,
  query: string,
  max: number,
): Promise<ToolOutput> {
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
  try {
    const r = await fetchText(doFetch, url);
    if (r.status >= 400) {
      return { ok: false, output: "", error: `搜索失败：HTTP ${r.status}（SearXNG 实例 ${base}——format=json 需要实例开启）` };
    }
    const data = JSON.parse(r.text) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = data.results ?? [];
    if (results.length === 0) {
      return { ok: true, output: `（无结果：${query}）` };
    }
    const lines = results.slice(0, max).map((item, i) => {
      const title = (item.title ?? "").replace(/\s+/g, " ").trim();
      const snippet = (item.content ?? "").replace(/\s+/g, " ").trim();
      return `${i + 1}. ${title}\n   ${item.url ?? ""}\n   ${snippet.slice(0, 200)}`;
    });
    return { ok: true, output: `搜索「${query}」前 ${lines.length} 条：\n\n${lines.join("\n\n")}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: "", error: `搜索失败: ${msg}` };
  }
}

/** DuckDuckGo HTML 端点解析（默认后端） */
async function searchDdg(doFetch: typeof globalThis.fetch, query: string, max: number): Promise<ToolOutput> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
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
      return { ok: true, output: `（无结果：${query}）` };
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
    return { ok: true, output: `搜索「${query}」前 ${lines.length} 条：\n\n${lines.join("\n\n")}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: "", error: `搜索失败: ${msg}` };
  }
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

/** 会话 web 工具组（composition 注入；fetch/env 可测试替换）。KCODE_SEARCH=none 时不含 web_search */
export function createWebTools(opts: WebToolOptions = {}): Tool[] {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const backend = resolveSearchBackend(opts.env ?? process.env);
  const tools: Tool[] = [webFetchTool(doFetch, opts.lookup ?? defaultLookup)];
  if (backend.kind !== "none") {
    tools.push(webSearchTool(doFetch, backend));
  }
  return tools;
}
