import fs from 'node:fs';
function edit(path, fn) { const old=fs.readFileSync(path,'utf8').replaceAll('\r\n','\n'); const next=fn(old); if(next===old) throw Error('unchanged '+path); fs.writeFileSync(path,next); }
function replace(s,a,b) { if(!s.includes(a)) throw Error('missing '+a.slice(0,100)); return s.replace(a,b); }
edit('packages/core/src/core/loop.ts',s=>{
 s=replace(s,'  type ChatMessage,','  type ChatMessage,\n  type RunStatus,');
 s=replace(s,'export interface RunSummary {','export interface RunSummary {\n  status: RunStatus;');
 const start=s.indexOf('    // user_prompt_submit 钩子'); const end=s.indexOf('    const maxTurns',start);
 s=s.slice(0,start)+s.slice(end);
 const gate=`    // 否决必须先于用户消息和技能注入，避免下一轮重新发送被拒绝内容。
    const promptGate = await this.gateHook((h) =>
      h.onUserPromptSubmit?.({ sessionId: this.sessionId, prompt: userInput }),
    );
    if (promptGate.veto || runOpts.signal?.aborted) {
      const status = runOpts.signal?.aborted ? "aborted" : "rejected";
      await this.emit({ v: 1, type: "session_end", ts: ts(), sessionId: this.sessionId,
        reason: status, ...(promptGate.reason !== undefined ? { detail: promptGate.reason } : {}) });
      await this.fireLifecycleHook((h) => h.onStop?.({ sessionId: this.sessionId }));
      return { sessionId: this.sessionId, turns: 0, toolCalls: 0, status };
    }
`;
 s=replace(s,'    await this.emit({\n      v: 1,\n      type: "user_message",',gate+'    await this.emit({\n      v: 1,\n      type: "user_message",');
 s=replace(s,'    let toolCalls = 0;','    let toolCalls = 0;\n    let status: RunStatus = "limit_reached";');
 s=replace(s,'        if (streamError !== undefined) {','        if (streamError !== undefined) {\n          status = "failed";');
 s=replace(s,'        if (calls.length === 0) {','        if (calls.length === 0) {\n          status = "completed";');
 s=replace(s,'    } finally {\n      if (turns >= maxTurns && !(signal?.aborted)) {','    } catch (err) {\n      status = "failed";\n      throw err;\n    } finally {\n      if (signal?.aborted) status = "aborted";\n      if (status === "limit_reached") {');
 s=replace(s,'reason: turns >= maxTurns || signal?.aborted ? "aborted" : "completed",','reason: status,');
 s=replace(s,'return { sessionId: this.sessionId, turns, toolCalls };','return { sessionId: this.sessionId, turns, toolCalls, status };');
 return s;
});
edit('apps/daemon/src/composition.ts',s=>{
 s=replace(s,'import { JsonlSessionSink,','import { SessionRunner, JsonlSessionSink,');
 s=replace(s,'  loop: AgentLoop;','  loop: AgentLoop;\n  runner: SessionRunner;');
 s=replace(s,'  abort(): void;','  abort(runId?: string): boolean;');
 const start=s.indexOf('  // 当前运行的 abort 控制器');const end=s.indexOf('  // applyMode 真身',start);
 s=s.slice(0,start)+`  const runner = new SessionRunner();
  const rawLoopRun = loop.run.bind(loop);
  loop.run = (input, runOpts = {}) => {
    try {
      return runner.start((signal) => rawLoopRun(input, {
        ...runOpts, signal: runOpts.signal === undefined ? signal : AbortSignal.any([signal, runOpts.signal]),
      })).result;
    } catch (err) { return Promise.reject(err); }
  };
`+s.slice(end);
 s=replace(s,'    loop,\n    sessionId,','    loop,\n    runner,\n    sessionId,');
 s=replace(s,'    abort: () => {\n      activeAbort?.abort();\n    },','    abort: (runId) => runner.abort(runId),');
 s=s.replaceAll('activeAbort !== null','runner.busy');
 s=replace(s,'    close: async () => {','    close: async () => {\n      runner.abort();');
 return s;
});
