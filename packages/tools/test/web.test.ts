import { describe, expect, it } from "vitest";
import type { Tool } from "@kcode/contracts";
import { createWebTools } from "../src/tools/web.js";

const ctx = (): { sessionId: string; cwd: string } => ({ sessionId: "s", cwd: "." });

function htmlResponse(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

const withFetch =
  (handler: (url: string) => Response): typeof fetch =>
  async (input: unknown) =>
    handler(String(input));

const webTools = createWebTools();
const webFetch = webTools[0]!;
const webSearch = webTools[1]!;

function makeTools(fetchMock: typeof fetch): Tool[] {
  return createWebTools({ fetch: fetchMock });
}

const makeToolsIdx0 = (fetchMock: typeof fetch): Tool => createWebTools({ fetch: fetchMock })[0]!;
const makeToolsIdx1 = (fetchMock: typeof fetch): Tool => createWebTools({ fetch: fetchMock })[1]!;
void webFetch;
void webSearch;

describe("web_fetch", () => {
  it("HTML 转可读文本：剥 script/style、解实体", async () => {
    const fetchTool = makeToolsIdx0(
      withFetch(() =>
        htmlResponse(
          "<html><head><script>evil()</script><style>a{}</style></head>" +
            "<body><h1>防洪评价规范</h1><p>GB50201&amp;SL&#65288;2014&#65289;</p></body></html>",
        ),
      ),
    );
    const r = await fetchTool.execute({ url: "https://example.com/doc" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("防洪评价规范");
    expect(r.output).toContain("GB50201");
    expect(r.output).not.toContain("evil()");
  });

  it("JSON 原样返回；重定向提示；非 http(s) 与内网地址拒绝", async () => {
    const fetchTool = makeToolsIdx0(
      withFetch((url) => {
        if (url.includes("/api")) {
          return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
        }
        // 模拟 fetch 跟随重定向后的最终响应（url 属性不可构造，只能 shadow）
        const r = new Response("moved", { status: 200, headers: { "content-type": "text/plain" } });
        Object.defineProperty(r, "url", { value: "https://final.example.com/x" });
        return r;
      }),
    );
    const json = await fetchTool.execute({ url: "https://example.com/api" }, ctx());
    expect(json.ok).toBe(true);
    expect(json.output).toContain('{"ok":true}');

    const redirected = await fetchTool.execute({ url: "https://example.com/redir" }, ctx());
    expect(redirected.ok).toBe(true);
    expect(redirected.output).toContain("重定向至");

    const ftp = await fetchTool.execute({ url: "ftp://example.com/f" }, ctx());
    expect(ftp.ok).toBe(false);
    expect(ftp.error).toContain("http/https");

    const intranet = await fetchTool.execute({ url: "http://192.168.1.1/admin" }, ctx());
    expect(intranet.ok).toBe(false);
    expect(intranet.error).toContain("SSRF");

    const localhost = await fetchTool.execute({ url: "http://localhost:8080/x" }, ctx());
    expect(localhost.ok).toBe(false);
    expect(localhost.error).toContain("SSRF");
  });

  it("HTTP 错误与网络失败明确报错", async () => {
    const fetchTool = makeToolsIdx0(
      withFetch(() => new Response("nope", { status: 404 })),
    );
    const r = await fetchTool.execute({ url: "https://example.com/404" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("404");
  });
});

describe("web_search", () => {
  const ddgHtml = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.mwr.gov.cn%2Fdoc">水利部防洪标准文件</a>
      <a class="result__snippet">防洪标准 GB50201-2014 相关技术要求…</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.com/2">第二条结果</a>
      <a class="result__snippet">摘要2</a>
    </div>`;

  it("解析标题/链接/摘要，DDG 跳转链接解包", async () => {
    const searchTool = makeToolsIdx1(withFetch(() => htmlResponse(ddgHtml)));
    const r = await searchTool.execute({ query: "防洪标准", maxResults: 2 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("水利部防洪标准文件");
    expect(r.output).toContain("https://www.mwr.gov.cn/doc");
    expect(r.output).toContain("第二条结果");
  });

  it("无结果与限流分别处理", async () => {
    const searchTool = makeToolsIdx1(
      withFetch((url) =>
        url.includes("empty")
          ? htmlResponse("<html><body>无结果页</body></html>")
          : new Response("forbidden", { status: 403 }),
      ),
    );
    // DDG 查询词固定在 URL：用两套实例区分
    const emptyTool = makeToolsIdx1(
      withFetch((url) =>
        url.includes(encodeURIComponent("防洪"))
          ? new Response("forbidden", { status: 403 })
          : htmlResponse("<html><body>nothing</body></html>"),
      ),
    );
    const empty = await emptyTool.execute({ query: "不存在的词xyz" }, ctx());
    expect(empty.ok).toBe(true);
    expect(empty.output).toContain("无结果");

    const limited = await searchTool.execute({ query: "防洪" }, ctx());
    expect(limited.ok).toBe(false);
    expect(limited.error).toContain("限流");
  });
});

describe("web 工具注册完整性", () => {
  it("两个工具均为只读", () => {
    expect(webFetch.definition.readOnly).toBe(true);
    expect(webSearch.definition.readOnly).toBe(true);
  });
});
