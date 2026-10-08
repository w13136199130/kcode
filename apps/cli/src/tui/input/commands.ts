import type { MutableRefObject } from "react";
import type {
  PermissionAsker,
  PermissionMode,
  SessionEvent,
  UserPromptPort,
} from "@kcode/contracts";
import type { Runtime } from "../../bootstrap.js";
import type { LocalSessionOptions, SessionHandle } from "../../session.js";
import type { Block, UiStore } from "@kcode/ui";
import type { QueuedCommand } from "@kcode/runtime";
import { MODE_META, MODE_CYCLE } from "../theme/modes.js";
import type { MenuOption } from "../dialogs/OptionsMenu.js";
import { contextWindowFor, modelWindowKnown } from "@kcode/core";
import { join, resolve } from "node:path";
import { atomicWriteText } from "@kcode/tools";
import { blocksToMarkdown } from "../export.js";
import type { LoginWizard } from "../dialogs/wizard-state.js";

/**
 * 命令分发（N2-3 自 App.tsx 外迁）：解析 !直执行 / 斜杠命令 / 纯文本提问。
 * 全部依赖经 DispatchContext 注入——本模块不 import runtime/session 实现，保持两端可搬。
 */
export interface DispatchContext {
  session: SessionHandle;
  sessionRef: MutableRefObject<SessionHandle | null>;
  props: { runtime: Runtime; cwd: string; historyFile?: string };
  ui: UiStore;
  modelLabel: string;
  mode: PermissionMode;
  inputHistory: MutableRefObject<string[]>;
  suppressNextUserBlock: MutableRefObject<boolean>;
  pushBlock(block: Block): void;
  setInput(value: string): void;
  setModelLabel(value: string): void;
  applyMode(next: PermissionMode): void;
  setFullAccessConfirm(v: boolean): void;
  setModelPicker(picker: { options: MenuOption[] } | null): void;
  setLoginWizard(w: LoginWizard): void;
  setResumePicker(p: { options: MenuOption[]; ids: string[] } | null): void;
  setPermissionsPanel(p: string[] | null): void;
  switchSession(resumeFrom: string): void;
  openRewindPicker(): void;
  runOccupied(session: SessionHandle, text: string, work: () => Promise<unknown>): Promise<void>;
  saveHistory(text: string): void;
  /** 进入运行态（busy/相位复位；见 App beginWork） */
  beginWork(): void;
  /** 复位中断已发标记（纯文本提交路径） */
  resetAbortSent(): void;
  createSession(opts: LocalSessionOptions): Promise<SessionHandle>;
  handleEvent(event: SessionEvent): void;
  appendDelta(delta: string): void;
  appendReasoning(delta: string): void;
  asker: PermissionAsker;
  askUser: UserPromptPort;
  onPlanApproval(payload: {
    plan: string;
    question: { question: string; options: { label: string; description?: string }[] };
    reply: (labels: string[]) => void;
  }): void;
  onQueueChange(items: readonly QueuedCommand[]): void;
}

/**
 * /model 菜单项的窗口注记（N3I-3）：窗口直接决定压缩阈值与价位感知，BYOK 切换是关键信息。
 * 表外模型标 "?" 不猜——与 /context 的 windowKnown 注记同源诚实化。
 */
export function modelWindowNote(ref: string): string {
  return modelWindowKnown(ref) ? `· ${Math.round(contextWindowFor(ref) / 1000)}k` : "· ?";
}

export async function runDispatch(ctx: DispatchContext, text: string, images?: string[]): Promise<void> {
  /** 分发一条输入（submit 直达或排空递归）：解析 !/斜杠命令与纯文本 */
    // ! 前缀：用户直执行 shell（不经 LLM、不问权限；结果仅显示）
    if (text.startsWith("!") && text.slice(1).trim() !== "") {
      const command = text.slice(1).trim();
      ctx.pushBlock({ kind: "user", text });
      ctx.saveHistory(text);
      await ctx.runOccupied(ctx.session, text, async () => {
        const result = await ctx.session.runBash(command);
        if (result === null) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: "✗ 命令执行失败（会话操作异常）" });
        } else {
          const shown = result.output.length > 2000 ? `${result.output.slice(0, 2000)}
（截断显示）` : result.output;
          ctx.pushBlock({
            kind: "info",
            tone: result.ok ? "ok" : "deny",
            text: `!${result.ok ? "" : " ✗"} ${command}（${Math.round(result.durationMs / 100) / 10}s）
${shown === "" ? "（无输出）" : shown}${result.error !== undefined && result.error !== "" ? `
${result.error}` : ""}`,
          });
        }
      });
      return;
    }

    if (text.startsWith("/")) {
      const body = text.slice(1);
      const spaceIndex = body.indexOf(" ");
      const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);
      const args = spaceIndex === -1 ? "" : body.slice(spaceIndex + 1).trim();
      ctx.setInput("");

      if (name === "ctx.mode") {
        const target = args === "" ? undefined : (args as PermissionMode);
        if (target === undefined) {
          // 循环切换（跳过 fullAccess）
          const index = MODE_CYCLE.indexOf(ctx.mode);
          const next = MODE_CYCLE[(index + 1) % MODE_CYCLE.length] ?? "default";
          ctx.applyMode(next);
          return;
        }
        if (!(target in MODE_META)) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: `未知模式 ${target}：可选 plan / default / acceptEdits / fullAccess` });
          return;
        }
        if (target === "fullAccess" && ctx.mode !== "fullAccess") {
          // 全自动放行风险高：显式确认后才生效
          ctx.setFullAccessConfirm(true);
          return;
        }
        ctx.applyMode(target);
        return;
      }
      if (name === "plan") {
        // 旧命令保留为 plan ↔ default 切换别名
        ctx.applyMode(ctx.mode === "plan" ? "default" : "plan");
        return;
      }
      if (name === "model") {
        if (args === "") {
          // 全量菜单（对齐批 B）：端点 /models 拉取（会话级缓存，失败回退配置态）；
          // 当前会话模型置顶高亮，Enter 会话级切换（setModel 语义不变）
          const info = await ctx.session.models().catch(() => null);
          if (info === null) {
            ctx.pushBlock({ kind: "info", tone: "warn", text: "模型清单获取失败（会话操作异常）" });
            return;
          }
          const available = await ctx.session.availableModels().catch(() => []);
          const providerPrefix =
            ctx.modelLabel.includes("/") ? ctx.modelLabel.split("/")[0]! : (info.default ?? "").split("/")[0] ?? info.providers[0] ?? "";
          const options: MenuOption[] = [];
          const seen = new Set<string>();
          const add = (ref: string, note?: string): void => {
            if (ref === "" || seen.has(ref)) {
              return;
            }
            seen.add(ref);
            options.push({
              key: String((options.length % 9) + 1),
              label: `${note !== undefined ? `${ref}（${note}）` : ref} ${modelWindowNote(ref)}`,
              value: ref,
            });
          };
          add(ctx.modelLabel, "当前会话");
          if (info.default !== undefined) {
            add(info.default, "配置默认");
          }
          for (const id of available) {
            add(providerPrefix !== "" ? `${providerPrefix}/${id}` : id);
          }
          options.push({ key: "q", label: available.length > 0 ? "取消（自定义直接 /model <provider/模型名>）" : "取消（端点未返回清单——自定义直接 /model <provider/模型名>）" });
          ctx.setModelPicker({ options });
          return;
        }
        const error = await ctx.session.setModel(args);
        if (error !== null) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: `✗ 模型切换失败：${error}` });
          return;
        }
        ctx.setModelLabel(args);
        ctx.pushBlock({ kind: "info", tone: "ok", text: `⭄ 模型已切换：${args}（历史保留）` });
        return;
      }
      if (name === "login") {
        ctx.setLoginWizard({ stage: "method", providerName: "", presetBaseURL: "", presetModel: "", baseURL: "", apiKey: "", model: "" });
        return;
      }
      if (name === "skills") {
        const skills = await ctx.session.listSkills().catch(() => null);
        ctx.pushBlock({
          kind: "info",
          text:
            skills === null || skills.length === 0
              ? "（当前会话未发现技能；可在 .kcode/skills/ 或 ~/.kcode/skills/ 添加）"
              : `已装载技能（${skills.length} 个，/skill <名称> 手动注入）：\n${skills
                  .map((s) => `· ${s.name} — ${s.description}`)
                  .join("\n")}`,
        });
        return;
      }
      if (name === "skill") {
        if (args === "") {
          ctx.pushBlock({ kind: "info", tone: "warn", text: "用法：/skill <名称>（/skills 查看清单）" });
          return;
        }
        const body = await ctx.session.skillBody(args);
        if (body === null) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: `✗ 技能 ${args} 不存在（/skills 查看清单）` });
          return;
        }
        ctx.pushBlock({ kind: "info", text: `📖 手动注入技能 ${args}` });
        ctx.suppressNextUserBlock.current = true;
        await ctx.runOccupied(ctx.session, text, () =>
          ctx.session.loop.run(`<skill name="${args}">
${body}
</skill>`),
        );
        return;
      }
      if (name === "sessions") {
        const sessions = await ctx.session.listSessions().catch(() => null);
        ctx.pushBlock({
          kind: "info",
          text:
            sessions === null || sessions.length === 0
              ? "（暂无历史会话）"
              : `最近会话（重启后 kcode --resume <id 前缀> 续接）：\n${sessions
                  .map((s) => `· ${s.sessionId.slice(0, 16)}… · ${s.turns} 轮 · ${s.preview || "（空）"}`)
                  .join("\n")}`,
        });
        return;
      }
      if (name === "resume") {
        const sessions = await ctx.session.listSessions().catch(() => null);
        if (sessions === null) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: "会话清单获取失败（会话操作异常）" });
          return;
        }
        const currentId = ctx.sessionRef.current?.sessionId;
        // 候选排除当前会话（续接自己没有意义）
        const candidates = sessions.filter((s) => s.sessionId !== currentId);
        if (args !== "") {
          // /resume latest 或 id 前缀：先校验存在，避免无效 id 静默开新会话
          const target =
            args.trim() === "latest"
              ? candidates[0]
              : candidates.find((s) => s.sessionId === args.trim() || s.sessionId.startsWith(args.trim()));
          if (target === undefined) {
            ctx.pushBlock({ kind: "info", tone: "warn", text: `✗ 未找到会话「${args.trim()}」（/sessions 查看清单）` });
            return;
          }
          ctx.switchSession(target.sessionId);
          return;
        }
        if (candidates.length === 0) {
          ctx.pushBlock({ kind: "info", text: "（暂无可续接的历史会话）" });
          return;
        }
        const top = candidates.slice(0, 10);
        ctx.setResumePicker({
          options: [
            ...top.map((s, i) => ({
              key: String((i + 1) % 10),
              label: `${s.sessionId.slice(0, 12)}… · ${s.turns} 轮 · ${s.preview || "（空）"}`,
            })),
            { key: "q", label: "取消" },
          ],
          ids: [...top.map((s) => s.sessionId), ""],
        });
        return;
      }
      if (name === "cost") {
        const usage = await ctx.session.usage().catch(() => null);
        if (usage === null) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: "用量获取失败（会话操作异常）" });
          return;
        }
        const fmt = (n: number): string => n.toLocaleString("en-US");
        const known = usage.inputTokens > 0 || usage.outputTokens > 0;
        ctx.pushBlock({
          kind: "info",
          text:
            `⏱ 本会话用量：输入 ${fmt(usage.inputTokens)} tok · 输出 ${fmt(usage.outputTokens)} tok` +
            `（合计 ${fmt(usage.inputTokens + usage.outputTokens)}）· LLM 调用 ${usage.calls} 次 · 模型 ${ctx.modelLabel}` +
            (known ? "\n（BYOK 自带 key，按厂商定价计费；旧版本会话或端点未回报用量时仅显示调用次数）" : ""),
        });
        return;
      }
      if (name === "clear") {
        if (ctx.ui.getState().busy) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: "运行中不能清屏开新会话（等本轮完成或 Esc 中断）" });
          return;
        }
        // 换会话语义：旧上下文的排队输入不带走——新会话的队列是空的，
        // 旧队列残留项将无人排空（悬挂）且排队计数停在旧值，必须在此清掉
        const stale = ctx.sessionRef.current?.commandQueue.clear() ?? 0;
        if (stale > 0) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: `已清空 ${stale} 条排队输入（新会话不带旧排队）` });
        }
        ctx.beginWork();
        try {
          const handle = await ctx.createSession({
            runtime: ctx.props.runtime,
            model: ctx.modelLabel,
            cwd: ctx.props.cwd,
            onEvent: ctx.handleEvent,
            onDelta: ctx.appendDelta,
            onReasoning: ctx.appendReasoning,
            onNotice: (n) => ctx.ui.getState().setNotice(n),
            asker: ctx.asker,
            askUser: ctx.askUser,
            onPlanApproval: ctx.onPlanApproval,
            onQueueChange: (items) => ctx.ui.getState().setQueuedCount(items.length),
          });
          ctx.sessionRef.current = handle;
          ctx.ui.getState().resetTranscript();
          // 清屏 + 重绘 banner（Static 里已打印的旧内容随滚动缓冲一并清除）
          process.stdout.write("[2J[0f");
          ctx.pushBlock({ kind: "banner", model: ctx.modelLabel, cwd: ctx.props.cwd });
          ctx.pushBlock({ kind: "info", tone: "ok", text: "已开启全新会话（上下文与转写已清空）" });
        } catch (err) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: `✗ 新会话创建失败：${err instanceof Error ? err.message : String(err)}` });
        } finally {
          ctx.ui.getState().finish();
        }
        return;
      }
      if (name === "status") {
        const usage = await ctx.session.usage().catch(() => null);
        const stats = await ctx.session.context().catch(() => null);
        const skills = await ctx.session.listSkills().catch(() => []);
        const fmt = (n: number): string => n.toLocaleString("en-US");
        const pct = stats !== null ? Math.min(100, Math.round((stats.historyTokens / stats.historyBudget) * 100)) : 0;
        ctx.pushBlock({
          kind: "info",
          text:
            `kcode · 会话 ${ctx.session.sessionId.slice(0, 16)}…
` +
            `模型 ${ctx.modelLabel} · 模式 ${MODE_META[ctx.mode].label} · 上下文 ${stats !== null ? `${fmt(stats.historyTokens)}/${fmt(stats.historyBudget)} tok（${pct}%）` : "未知"}
` +
            `LLM 调用 ${usage !== null ? usage.calls : "?"} 次 · 输入 ${usage !== null ? fmt(usage.inputTokens) : "?"} tok · 输出 ${usage !== null ? fmt(usage.outputTokens) : "?"} tok
` +
            (stats !== null && stats.sessionBudgetTokens !== undefined
              ? `预算 ${Math.round((stats.sessionUsage.inputTokens + stats.sessionUsage.outputTokens) / 1000)}k/${Math.round(stats.sessionBudgetTokens / 1000)}k tok（N3I-8 到顶问询）
`
              : "") +
            `技能 ${skills.length} 个 · 子代理 可用（/help 查看） · cwd ${ctx.props.cwd}`,
        });
        return;
      }
      if (name === "mcp") {
        // N3I-7：/mcp tools <名称> 列单个已连接服务器的工具清单
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (parts[0] === "tools") {
          const server = parts.slice(1).join(" ");
          if (server === "") {
            ctx.pushBlock({ kind: "info", tone: "warn", text: "用法：/mcp tools <服务器名>（/mcp 查看状态）" });
            return;
          }
          const tools = await ctx.session.mcpTools(server).catch(() => null);
          if (tools === null) {
            ctx.pushBlock({ kind: "info", tone: "warn", text: `服务器「${server}」未连接（/mcp 查看状态）` });
            return;
          }
          ctx.pushBlock({
            kind: "info",
            text:
              tools.length === 0
                ? `（${server} 已连接但没有工具）`
                : `MCP ${server} 工具（${tools.length} 个）：\n${tools.map((t) => `- ${t}`).join("\n")}`,
          });
          return;
        }
        const servers = await ctx.session.mcpStatus().catch(() => null);
        const guide = "\n增删：kcode mcp add/remove（终端执行）· 工具清单：/mcp tools <名称>";
        ctx.pushBlock({
          kind: "info",
          text:
            servers === null
              ? "MCP 状态获取失败（会话操作异常）"
              : servers.length === 0
                ? "（未配置 MCP 服务器——~/.kcode/mcp.json 可添加；支持 stdio / http / sse 三种传输）" + guide
                : `MCP 服务器（${servers.filter((x) => x.ok).length}/${servers.length} 接入成功）：
${servers
                    .map(
                      (x) =>
                        `${x.ok ? "✓" : "✗"} ${x.name} · ${x.transport} · ${x.tools} 个工具${x.ok ? "" : "（连接失败，查看启动告警）"}`,
                    )
                    .join("\n")}` + guide,
        });
        return;
      }
      if (name === "hooks") {
        const hooks = await ctx.session.hooksInfo().catch(() => null);
        if (hooks === null) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: "hooks 清单获取失败（会话操作异常）" });
          return;
        }
        ctx.pushBlock({
          kind: "info",
          text:
            hooks.length === 0
              ? "（未配置 hooks——~/.kcode/hooks.json 用户级始终生效；项目 .kcode/hooks.json 需 /trust 信任）"
              : `已装载 hooks（${hooks.length} 条）：
${hooks
                .map(
                  (h) =>
                    `${h.source === "user" ? "用户" : "项目"} · ${h.event} · ${h.command}${h.failClosed === true ? "（fail-closed）" : ""}`,
                )
                .join("\n")}\n配置：~/.kcode/hooks.json（用户）/ .kcode/hooks.json（项目，需信任）`,
        });
        return;
      }
      if (name === "export") {
        // N3I-6：转写块 → Markdown 落盘（原子写复用 N3I-1 公共件）
        const blocks = ctx.ui.getState().blocks;
        const target =
          args.trim() !== ""
            ? resolve(ctx.props.cwd, args.trim())
            : join(ctx.props.cwd, `kcode-session-${ctx.session.sessionId.slice(0, 8)}.md`);
        try {
          await atomicWriteText(target, blocksToMarkdown(blocks));
          ctx.pushBlock({ kind: "info", tone: "ok", text: `✓ 已导出会话（${blocks.length} 块）→ ${target}` });
        } catch (err) {
          ctx.pushBlock({
            kind: "info",
            tone: "warn",
            text: `✗ 导出失败：${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }
      if (name === "trust") {
        await ctx.session.trustProject();
        ctx.pushBlock({ kind: "info", text: "已信任当前项目（项目级 hooks/技能/命令将生效）" });
        return;
      }
      if (name === "rewind") {
        ctx.openRewindPicker();
        return;
      }
      if (name === "compact") {
        if (ctx.ui.getState().busy) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: "运行中不能压缩（等本轮完成或 Esc 中断）" });
          return;
        }
        const result = await ctx.session.compact();
        if (typeof result === "string") {
          ctx.pushBlock({ kind: "info", tone: "warn", text: `✗ 压缩失败：${result}` });
          return;
        }
        ctx.pushBlock({
          kind: "info",
          tone: result.dropped > 0 ? "ok" : undefined,
          text:
            result.dropped > 0
              ? `⑂ 已手动压缩：折叠 ${result.dropped} 条较早消息（摘要 ${result.summaryChars} 字），任务锚点与近期上下文保留`
              : "（历史尚短，未触发压缩——压缩在历史超过预算 60% 时也会自动进行）",
        });
        return;
      }
      if (name === "context") {
        const stats = await ctx.session.context().catch(() => null);
        if (stats === null) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: "上下文信息获取失败（会话操作异常）" });
          return;
        }
        const fmt = (n: number): string => n.toLocaleString("en-US");
        const pct = Math.min(100, Math.round((stats.historyTokens / stats.historyBudget) * 100));
        const barLen = Math.max(1, Math.round(pct / 2.5));
        ctx.pushBlock({
          kind: "info",
          text:
            `Context · 模型 ${stats.model}（窗口 ${(stats.contextWindow / 1000).toFixed(0)}k${
              stats.windowKnown ? "" : "，未在窗口表内按默认估算——实际更大请反馈补表"
            }）
` +
            `历史 ${fmt(stats.historyTokens)} / ${fmt(stats.historyBudget)} tok（${pct}%）
` +
            `[${"█".repeat(barLen)}${"░".repeat(Math.max(0, 40 - barLen))}]
` +
            `系统提示 ${fmt(stats.systemTokens)} tok · ${stats.pinnedAnchor ? "已钉固计划锚点" : "无计划锚点"} · 超预算自动压缩、/compact 手动压缩` +
            (stats.sessionBudgetTokens !== undefined
              ? `\n会话预算 ${Math.round((stats.sessionUsage.inputTokens + stats.sessionUsage.outputTokens) / 1000)}k/${Math.round(stats.sessionBudgetTokens / 1000)}k tok（input+output 累计，到顶问询继续/停止）`
              : ""),
        });
        return;
      }
      if (name === "permissions") {
        const grants = await ctx.session.listPersistentGrants().catch(() => null);
        if (grants === null) {
          ctx.pushBlock({ kind: "info", tone: "warn", text: "持久放行清单获取失败（会话操作异常）" });
          return;
        }
        if (grants.length === 0) {
          ctx.pushBlock({ kind: "info", text: "本项目无持久放行（权限确认时选「允许，本项目不再询问」可添加）" });
          return;
        }
        ctx.setPermissionsPanel(grants);
        return;
      }
      if (name === "help") {
        const customs = ctx.session
          .listCommands()
          .map((c) => `/${c.name}${c.source === "project" ? "（项目）" : "（用户）"}`);
        const builtins = [
          "/ctx.mode [名称] 切换权限模式（plan/default/acceptEdits/fullAccess）",
          "/model [引用] 查看/切换模型（无参出选择菜单）",
          "/login 配置模型厂商与 API key（向导，自动写配置）",
          "/skills · /skill <名称> 查看/手动注入技能",
          "/sessions 最近会话列表",
          "/resume [latest|id 前缀] 不重启续接历史会话",
          "/rewind 回退到之前某轮提问（文件快照+对话一起回滚；空闲双击 Esc 直达）",
          "/compact 手动压缩历史 · /context 查看 token 占用（超预算 60% 自动压缩）",
          "/clear 清屏开新会话 · /status 会话状态一览 · /mcp MCP 接入状态",
          "!命令 直接执行 shell（结果仅显示） · Shift+Tab 循环权限模式 · @ 补全文件路径",
          "运行中提交的输入自动排队，本轮完成后按序执行（Esc/Ctrl+C 中断将清空排队）",
          "/permissions 查看本项目持久放行（权限确认选「本项目不再询问」产生）",
          "/cost 查看本会话 token 用量（含 --resume 续接的历史用量）",
          "/plan 计划模式快捷切换",
          "/trust 信任当前项目",
          "/help 显示本帮助",
          "exit 退出",
        ];
        ctx.pushBlock({
          kind: "info",
          text: `内置命令：\n${builtins.join("\n")}${customs.length > 0 ? `\n自定义命令：\n${customs.join("\n")}` : "\n（暂无自定义命令，可在 .kcode/commands/*.md 添加）"}`,
        });
        return;
      }
      const expanded = await ctx.session.expandCommand(name, args);
      if (expanded === null) {
        ctx.pushBlock({ kind: "info", text: `未知命令 /${name}（/help 查看可用命令）` });
        return;
      }
      ctx.saveHistory(text);
      await ctx.runOccupied(ctx.session, text, () => ctx.session.loop.run(expanded));
      return;
    }

    ctx.setInput("");
    ctx.saveHistory(text);
    ctx.resetAbortSent();
    // 图片附件（N3C-4⑤）只随普通提问发送；斜杠/自定义命令路径不消费 images
    await ctx.runOccupied(ctx.session, text, () =>
      ctx.session.loop.run(text, images !== undefined && images.length > 0 ? { images } : {}),
    );

}
