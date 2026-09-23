import fs from 'node:fs';
const edit=(p,f)=>fs.writeFileSync(p,f(fs.readFileSync(p,'utf8').replaceAll('\r\n','\n')));
const rep=(s,a,b)=>{if(!s.includes(a))throw Error(a);return s.replace(a,b)};
edit('packages/core/src/core/loop.ts',s=>rep(s,'runOpts: { images?: string[]; signal?: AbortSignal }','runOpts: { images?: string[]; signal?: AbortSignal; runId?: string }'));
edit('apps/daemon/src/composition.ts',s=>rep(s,'      })).result;','      }), runOpts.runId).result;'));
edit('packages/contracts/src/localapi.ts',s=>{
 s=rep(s,'import { SessionEvent }','import { RunStatus, SessionEvent }');
 s=rep(s,'PROTOCOL_VERSION = 9','PROTOCOL_VERSION = 10');
 s=rep(s,'method: z.literal("session_send"),','method: z.literal("session_send"),\n    runId: z.string().min(1).optional(),');
 s=rep(s,'method: z.literal("session_abort"),','method: z.literal("session_abort"),\n    runId: z.string().min(1).optional(),');
 s=rep(s,'z.object({ kind: z.literal("accepted"), id: requestId })','z.object({ kind: z.literal("accepted"), id: requestId, runId: z.string().optional() })');
 return rep(s,'kind: z.literal("run_done"),','kind: z.literal("run_done"),\n    runId: z.string(),\n    status: RunStatus,');
});
edit('apps/daemon/src/server.ts',s=>{
 s=rep(s,'  pendingAsks: Map','  interactionOwners: Map<string, string>;\n  pendingAsks: Map');
 s=rep(s,'      pendingAsks: new Map(),','      interactionOwners: new Map(),\n      pendingAsks: new Map(),');
 s=rep(s,'                  conn.pendingAsks.set(call.callId,','                  conn.interactionOwners.set(call.callId, session.sessionId);\n                  conn.pendingAsks.set(call.callId,');
 s=s.replaceAll('                  conn.pendingQuestions.set(questionId,','                  conn.interactionOwners.set(questionId, session.sessionId);\n                  conn.pendingQuestions.set(questionId,');
 const start=s.indexOf('        send(conn, { kind: "accepted", id: message.id });',s.indexOf('case "session_send"'));
 const end=s.indexOf('          .then((summary)',start);
 s=s.slice(0,start)+`        if (session.runner.busy) {
          send(conn, { kind: "error", id: message.id, message: "会话正在运行，请等待完成或先中断" });
          return;
        }
        const result = session.loop.run(message.content, { images: message.images, runId: message.runId });
        const runId = session.runner.runId!;
        send(conn, { kind: "accepted", id: message.id, runId });
        void result
`+s.slice(end);
 s=rep(s,'              sessionId: summary.sessionId,','              sessionId: summary.sessionId,\n              runId,\n              status: summary.status,');
 s=rep(s,'              sessionId: message.sessionId,\n              turns: 0,','              sessionId: message.sessionId,\n              runId,\n              status: "failed",\n              turns: 0,');
 s=rep(s,'        // 先结算未决交互',`        if (!session.abort(message.runId)) {
          send(conn, { kind: "error", id: message.id, message: "运行已结束或 runId 不匹配" });
          return;
        }
        // 先结算未决交互`);
 s=rep(s,'        for (const [callId, resolve] of conn.pendingAsks) {','        for (const [callId, resolve] of conn.pendingAsks) {\n          if (conn.interactionOwners.get(callId) !== message.sessionId) continue;');
 s=rep(s,'        for (const [questionId, resolve] of conn.pendingQuestions) {','        for (const [questionId, resolve] of conn.pendingQuestions) {\n          if (conn.interactionOwners.get(questionId) !== message.sessionId) continue;');
 s=rep(s,'        session.abort();\n','');
 // 所有结算位置同步清理所有权索引。
 s=s.replace(/conn\.pendingAsks\.delete\(([^)]+)\);/g,'conn.pendingAsks.delete($1); conn.interactionOwners.delete($1);');
 s=s.replace(/conn\.pendingQuestions\.delete\(([^)]+)\);/g,'conn.pendingQuestions.delete($1); conn.interactionOwners.delete($1);');
 return s;
});
edit('apps/cli/src/daemon-client.ts',s=>{
 s=s.replaceAll('(sessionId: string, turns: number, toolCalls: number) => void','(sessionId: string, turns: number, toolCalls: number, runId: string, status: import("@kcode/contracts").RunStatus) => void');
 return rep(s,'l(message.sessionId, message.turns, message.toolCalls);','l(message.sessionId, message.turns, message.toolCalls, message.runId, message.status);');
});
edit('apps/cli/src/session.ts',s=>{
 s=rep(s,'import type {','import { randomUUID } from "node:crypto";\nimport type {');
 s=s.replaceAll('sessionId: string; turns: number; toolCalls: number','sessionId: string; turns: number; toolCalls: number; status: import("@kcode/contracts").RunStatus');
 s=rep(s,'  const runDoneWaiters = new Set<{','  let activeRunId: string | undefined;\n  const runDoneWaiters = new Set<{');
 s=rep(s,'opts.client.onRunDone((sid, turns, toolCalls) => {\n    if (sid === sessionId)', 'opts.client.onRunDone((sid, turns, toolCalls, runId, status) => {\n    if (sid === sessionId && runId === activeRunId)');
 s=rep(s,'waiter.resolve({ sessionId: sid, turns, toolCalls });','waiter.resolve({ sessionId: sid, turns, toolCalls, status });');
 const start=s.indexOf('      run: async (input, runOpts) => {');const end=s.indexOf('    setMode:',start);
 s=s.slice(0,start)+`      run: async (input, runOpts) => {
        if (activeRunId !== undefined) throw new Error("会话正在运行");
        const runId = randomUUID();
        activeRunId = runId;
        try {
          return await new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            // 必须先订阅再发送：空回复或 gate 拒绝可能与 accepted 同批到达。
            runDoneWaiters.add(waiter);
            void opts.client.request({ method: "session_send", sessionId, runId, content: input,
              ...(runOpts?.images !== undefined ? { images: runOpts.images } : {}),
            }).then((response) => {
              if (response.kind !== "accepted") throw new Error("运行请求未被接受");
            }).catch((err) => { runDoneWaiters.delete(waiter); reject(err); });
          });
        } finally { if (activeRunId === runId) activeRunId = undefined; }
      },
    },
    abort: () => {
      if (activeRunId === undefined) return;
      void opts.client.request({ method: "session_abort", sessionId, runId: activeRunId }).catch(() => {});
    },
`+s.slice(end);return s;
});
edit('apps/cli/src/tui/App.tsx',s=>{
 s=rep(s,'    abortSent.current = true;','    abortSent.current = true;\n    setNotice("正在取消，等待当前操作退出…");');
 s=rep(s,'      case "todo_update":',`      case "session_end":
        if (event.reason !== "completed") {
          flushStream();
          const labels = { failed: "本轮执行失败", aborted: "已取消本轮执行", limit_reached: "已达到运行上限，任务可能未完成", rejected: "输入被 user_prompt_submit 钩子拒绝" };
          pushBlock({ kind: "info", tone: "warn", text: labels[event.reason] + (event.detail ? "：" + event.detail : "") });
        }
        break;
      case "todo_update":`); return s;
});
