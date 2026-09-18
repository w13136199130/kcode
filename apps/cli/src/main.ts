/**
 * apps/cli（薄壳，零业务逻辑，§4.1）。P1 落地：
 * spawn/attach daemon（token 经继承 stdio 传递，§5.6.2）、Ink TUI 渲染与输入（要求 Windows Terminal）。
 * 只通过 daemon 本地 API 通信，禁止 import packages（类型除外，§4.2 规则 4）。
 */
console.log("kcode cli — P1 落地（见 ARCHITECTURE.md §9）");
