/** 实际 KcodeApp + daemon + 工具管线；仅模型替换为离线、可复现的验收模型。 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { render } from "ink";
import type { LLMProvider } from "@kcode/contracts";
import { startDaemon } from "../../daemon/src/server.js";
import { DaemonClient } from "../src/daemon-client.js";
import { createSession } from "../src/session.js";
import { KcodeApp } from "../src/tui/App.js";

const smoke = process.argv.includes("--smoke");
if (!smoke && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  console.error("请在真实终端直接运行此文件；不要管道转发 stdout。自动连通性检查使用 --smoke。");
  process.exit(1);
}
const artifacts = resolve(".artifacts/m0-terminal");
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(artifacts, "run-"));
const workspace = join(root, "workspace");
const home = join(root, "home");
await mkdir(workspace, { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(join(workspace, "sample.txt"), "M0 local fixture\n");
const journal = join(root, "observations.jsonl");
const record = (kind: string, payload: unknown): void => {
  appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), kind, payload }) + "\n");
};
record("environment", { smoke, platform: process.platform, node: process.version,
  terminal: process.env.TERM_PROGRAM ?? (process.env.WT_SESSION ? "Windows Terminal" : "unknown"),
  columns: process.stdout.columns, rows: process.stdout.rows, workspace });
const model: LLMProvider = {
  id: "m0-local",
  async *stream(req) {
    const last = req.messages.at(-1);
    const text = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (last?.role === "tool" && text !== "m0:limit") {
      yield { type: "text", text: `工具返回：${last.content}` };
    } else if (text === "m0:stream") {
      for (let i = 1; i <= 120; i++) {
        try { await delay(250, undefined, { signal: req.signal }); } catch { return; }
        yield { type: "text", text: `片段${i} · 中文2 / é / 👩🏽‍💻\n` };
      }
    } else if (text === "m0:ask") {
      yield { type: "tool_call", callId: randomUUID(), tool: "write",
        args: { path: "approval-sample.txt", content: "仅用于 M0 审批验收\n" } };
      yield { type: "end", reason: "tool_use" }; return;
    } else if (text === "m0:shell") {
      yield { type: "tool_call", callId: randomUUID(), tool: "bash", args: {
        command: `node -e "console.log('M0 shell started'); setTimeout(()=>console.log('M0 shell finished'),30000)"`,
        timeoutMs: 45000,
      } };
      yield { type: "end", reason: "tool_use" }; return;
    } else if (text === "m0:limit") {
      yield { type: "tool_call", callId: randomUUID(), tool: "read", args: { path: "sample.txt" } };
      yield { type: "end", reason: "tool_use" }; return;
    } else if (text === "m0:error") {
      yield { type: "end", reason: "error", error: "M0 人工构造的模型错误（预期）" }; return;
    } else if (text === "m0:font") {
      yield { type: "text", text: "字体对照（请观察终端，不以日志替代）：\nASCII: Il1 O0 [] {} <>\n中文：版本2 修复3处 api你好1\n字符簇：é 👨‍👩‍👧‍👦 👩🏽‍💻\n表格：\n| 内容 | 值 |\n| --- | --- |\n| 中文 | 2 |\n| English | 3 |\n\n```ts\nconst 版本 = 2;\n```" };
    } else {
      yield { type: "text", text: `收到原文（JSON 转义展示换行）：${JSON.stringify(text)}` };
    }
    yield { type: "end", reason: "stop" };
  },
};
const id = randomUUID();
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\kcode-m0-${id}` : join(root, "daemon.sock");
const daemon = await startDaemon({ pipePath, token: id, kcodeHomeDir: home,
  llmFactory: async () => model, modelsInfo: () => ({ default: "m0-local", providers: ["m0-local"] }),
  daemonVersion: "m0-terminal-acceptance" });
let client: DaemonClient | undefined;
try {
  client = await DaemonClient.open({ pipePath, token: id });
  client.onEvent((sessionId, event) => record("event", { sessionId, event }));
  client.onRunDone((sessionId, turns, toolCalls, runId, status) => record("run_done", { sessionId, turns, toolCalls, runId, status }));
  client.onAsk((callId, tool, args) => record("approval_shown", { callId, tool, args }));
  if (smoke) {
    const session = await createSession({ client, model: model.id, cwd: workspace,
      asker: { confirm: async () => false } });
    for (const [input, expected] of [["版本2 api你好1", "completed"], ["m0:error", "failed"], ["m0:ask", "completed"], ["m0:limit", "limit_reached"]] as const) {
      const result = await session.loop.run(input);
      if (result.status !== expected) throw new Error(`${input}: expected ${expected}, got ${result.status}`);
      console.log(`${input}: ${result.status}`);
    }
    const timer = setTimeout(() => session.abort(), 600);
    try {
      const result = await session.loop.run("m0:stream");
      if (result.status !== "aborted") throw new Error(`stream: ${result.status}`);
      console.log("stream: aborted");
    } finally { clearTimeout(timer); }
  } else {
    console.log(`M0 离线终端验收：${root}\n普通文字原样回显；m0:font / m0:stream / m0:ask / m0:shell / m0:error / m0:limit\n输入法请实际键入并选择候选；取消按 Esc，空闲输入 exit 退出。`);
    const ui = render(<KcodeApp client={client} model={model.id} cwd={workspace} historyFile={join(root, "input-history.json")} />, { exitOnCtrlC: false });
    await ui.waitUntilExit();
  }
} finally {
  client?.close();
  await daemon.close();
  record("exit", { columns: process.stdout.columns, rows: process.stdout.rows });
  console.log(`验收记录：${journal}`);
}
