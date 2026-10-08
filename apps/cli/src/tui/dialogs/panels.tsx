import type { PermissionAnswer } from "@kcode/contracts";
import { useServices } from "@kcode/ui";
import { Box, Text } from "ink";
import { c } from "../theme/theme.js";
import { truncateVisual } from "../terminal/width.js";
import { markdownToLines } from "../transcript/markdown.js";
import { OptionsMenu, type MenuOption } from "./OptionsMenu.js";
import { DiffPreview } from "./DiffPreview.js";
import type { CliServices } from "../state/services.js";
import type { AskState, QuestionState, PlanApprovalState, RewindPoint } from "../state/interactions.js";

export type { RewindPoint } from "../state/interactions.js";

/** 面板动作捷径（各面板从 ServicesProvider 取，不再经 props 透传） */
function useDialogs(): CliServices["dialogs"] {
  return useServices<CliServices>().dialogs;
}

/** 工具审批面板：允许/本会话/本项目持久/拒绝 四选 */
export function AskPanel(props: { ask: AskState }) {
  const dialogs = useDialogs();
  const { ask } = props;
  return (
    <Box flexDirection="column">
      <Text color={c("accent")}>
        ⚠ 允许 {ask.call.tool} {JSON.stringify(ask.call.args).slice(0, 80)} ？
      </Text>
      {ask.call.preview !== undefined && <DiffPreview preview={ask.call.preview} />}
      <OptionsMenu
        cancelLabel="Esc = 拒绝"
        options={[
          { key: "y", label: "允许" },
          { key: "s", label: "允许，本会话不再询问" },
          { key: "p", label: "允许，本项目不再询问（持久）" },
          { key: "n", label: "拒绝" },
        ]}
        onPick={(indices) => {
          const picked = indices[0] ?? 3;
          const answer: PermissionAnswer =
            picked === 0
              ? { allowed: true }
              : picked === 1
                ? { allowed: true, scope: "session" }
                : picked === 2
                  ? { allowed: true, scope: "project" }
                  : { allowed: false };
          ask.resolve(answer);
          dialogs.setAsk(null);
          dialogs.pushBlock({
            kind: "info",
            tone: answer.allowed ? "ok" : "deny",
            text: `❯ ${
              picked === 0
                ? "允许"
                : picked === 1
                  ? "允许（本会话）"
                  : picked === 2
                    ? "允许（本项目持久）"
                    : "拒绝"
            } · ${ask.call.tool}`,
          });
        }}
        onCancel={() => {
          ask.resolve({ allowed: false });
          dialogs.setAsk(null);
          dialogs.pushBlock({ kind: "info", tone: "deny", text: `❯ 拒绝 · ${ask.call.tool}` });
        }}
      />
    </Box>
  );
}

/** 计划批准面板（plan_submit）：批准即切执行档，继续研究/放弃留在计划档 */
export function PlanApprovalPanel(props: { planApproval: PlanApprovalState }) {
  const dialogs = useDialogs();
  const { planApproval } = props;
  return (
    <Box flexDirection="column">
      <Text color={c("brand")} bold>
        📋 执行计划（plan_submit 提交，等待批准）
      </Text>
      {markdownToLines(planApproval.plan).map((line, i) => (
        <Text key={i}>
          {line.segments.map((seg, j) => (
            <Text
              key={j}
              color={seg.color}
              bold={seg.bold}
              italic={seg.italic}
              dimColor={seg.dimColor}
              strikethrough={seg.strikethrough}
            >
              {seg.text}
            </Text>
          ))}
        </Text>
      ))}
      <OptionsMenu
        options={planApproval.question.options.map((o, i) => ({
          key: String(i + 1),
          label: o.description !== undefined ? `${o.label} — ${o.description}` : o.label,
        }))}
        initialIndex={2}
        onPick={(indices) => {
          const picked = planApproval.question.options[indices[0] ?? 2];
          const approve = picked?.label === "批准并执行";
          planApproval.reply(picked !== undefined ? [picked.label] : []);
          dialogs.setPlanApproval(null);
          if (approve) {
            dialogs.setMode("default");
            dialogs.applyMode("default");
            dialogs.pushBlock({ kind: "info", tone: "ok", text: "✓ 计划已批准——切换到执行模式" });
          } else {
            dialogs.pushBlock({
              kind: "info",
              tone: "warn",
              text: `❯ ${picked?.label ?? "取消"} · 计划未执行`,
            });
          }
        }}
        onCancel={() => {
          planApproval.reply(["放弃"]);
          dialogs.setPlanApproval(null);
          dialogs.pushBlock({ kind: "info", tone: "deny", text: "❯ 放弃 · 计划未执行" });
        }}
      />
    </Box>
  );
}

/** 回退点选择（/rewind）：恢复文件快照 + 截断对话 */

export function RewindPickerPanel(props: { points: RewindPoint[] }) {
  const dialogs = useDialogs();
  return (
    <Box flexDirection="column">
      <Text color={c("accent")} bold>
        选择回退点（回到该提问之前：恢复文件快照 + 截断对话 · Esc 取消）
      </Text>
      <OptionsMenu
        options={[
          ...props.points.map((pt, i) => ({
            key: String((i + 1) % 10),
            label: `${pt.preview || "（空）"}${pt.fileChanges > 0 ? ` · ${pt.fileChanges} 处文件改动` : ""}`,
          })),
          { key: "q", label: "取消" },
        ]}
        initialIndex={0}
        onPick={(indices) => {
          const pt = props.points[indices[0] ?? -1];
          dialogs.setRewindPicker(null);
          if (pt === undefined) return;
          void (async () => {
            const error = await dialogs.rewind(pt.eventIndex);
            dialogs.pushBlock({
              kind: "info",
              tone: error === null ? "ok" : "warn",
              text:
                error === null
                  ? `⏪ 已回退到「${pt.preview || "（空）"}」之前（文件快照已恢复，对话已截断；上方转写仅作显示）`
                  : `✗ 回退失败：${error}`,
            });
          })();
        }}
        onCancel={() => {
          dialogs.setRewindPicker(null);
        }}
      />
    </Box>
  );
}

/** /resume 会话选择 */
export function ResumePickerPanel(props: { options: MenuOption[]; ids: string[] }) {
  const dialogs = useDialogs();
  return (
    <Box flexDirection="column">
      <Text color={c("accent")} bold>
        选择要续接的会话（回车确认 · Esc 取消）
      </Text>
      <OptionsMenu
        options={props.options}
        onPick={(indices) => {
          const idx = indices[0] ?? props.ids.length - 1;
          const resumeId = props.ids[idx];
          dialogs.setResumePicker(null);
          if (resumeId !== undefined && resumeId !== "") {
            dialogs.switchSession(resumeId);
          }
        }}
        onCancel={() => {
          dialogs.setResumePicker(null);
        }}
      />
    </Box>
  );
}

/** /permissions 持久放行清单与清空 */
export function PermissionsPanel(props: { grants: string[] }) {
  const dialogs = useDialogs();
  return (
    <Box flexDirection="column">
      <Text color={c("accent")} bold>
        本项目持久放行（{props.grants.length} 项，存于 ~/.kcode/permissions.json）：
      </Text>
      {props.grants.map((p) => (
        <Text key={p}> · {p}</Text>
      ))}
      <OptionsMenu
        options={[
          { key: "n", label: "关闭" },
          { key: "c", label: "清空本项目的持久放行" },
        ]}
        initialIndex={0}
        onPick={(indices) => {
          const grants = props.grants;
          dialogs.setPermissionsPanel(null);
          if ((indices[0] ?? 0) === 1) {
            void (async () => {
              const ok = await dialogs.clearPersistentGrants().catch(() => false);
              dialogs.pushBlock({
                kind: "info",
                tone: ok ? "ok" : "warn",
                text: ok
                  ? `❯ 已清空本项目持久放行（${grants.length} 项）`
                  : "✗ 清除失败（会话操作异常）",
              });
            })();
          }
        }}
        onCancel={() => {
          dialogs.setPermissionsPanel(null);
        }}
      />
    </Box>
  );
}

/** fullAccess 显式确认（全自动放行高风险） */
export function FullAccessConfirmPanel() {
  const dialogs = useDialogs();
  const cancel = (): void => {
    dialogs.setFullAccessConfirm(false);
    dialogs.pushBlock({ kind: "info", text: "❯ 取消 · 未切换完全访问" });
  };
  return (
    <Box flexDirection="column">
      <Text color={c("destructive")} bold>
        ⚠ 切换到完全访问？此会话内全部工具（含 bash）自动放行。
      </Text>
      <OptionsMenu
        options={[
          { key: "n", label: "取消" },
          { key: "y", label: "确认切换（全部自动放行）" },
        ]}
        initialIndex={0}
        onPick={(indices) => {
          dialogs.setFullAccessConfirm(false);
          if ((indices[0] ?? 0) === 1) {
            dialogs.applyMode("fullAccess");
          } else {
            cancel();
          }
        }}
        onCancel={cancel}
      />
    </Box>
  );
}

/** /model 选择菜单 */
export function ModelPickerPanel(props: { options: MenuOption[] }) {
  const dialogs = useDialogs();
  return (
    <Box flexDirection="column">
      <Text color={c("accent")} bold>
        Select model（Enter 切换 · Esc 取消；自定义模型用 /model &lt;provider/模型名&gt;）
      </Text>
      <OptionsMenu
        options={props.options}
        onPick={(indices) => {
          const picked = props.options[indices[0] ?? 0];
          dialogs.setModelPicker(null);
          if (picked === undefined || picked.key === "q") {
            return;
          }
          const ref = picked.label.replace(/（.*$/, "");
          void (async () => {
            const error = await dialogs.setModel(ref);
            if (error !== null) {
              dialogs.pushBlock({ kind: "info", tone: "warn", text: `✗ 模型切换失败：${error}` });
              return;
            }
            dialogs.setModelLabel(ref);
            dialogs.pushBlock({ kind: "info", tone: "ok", text: `⭄ 模型已切换：${ref}（历史保留）` });
          })();
        }}
        onCancel={() => dialogs.setModelPicker(null)}
      />
    </Box>
  );
}

/** ask_user 结构化提问（多选/单选 + 选中项预览） */
export function QuestionPanel(props: { question: QuestionState }) {
  const dialogs = useDialogs();
  const { question } = props;
  return (
    <Box flexDirection="column">
      <Text color={c("accent")} bold>
        ? {question.question.question}
      </Text>
      <OptionsMenu
        options={question.question.options.map((o) => ({
          key: String(question.question.options.indexOf(o) + 1),
          label: o.label + (o.description !== undefined ? ` — ${o.description}` : ""),
        }))}
        footer={(i) => {
          const preview = question.question.options[i]?.preview;
          if (preview === undefined) {
            return null;
          }
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>预览：</Text>
              {preview.split("\n").slice(0, 12).map((line, j) => (
                <Text key={j}>{truncateVisual(line, 120)}</Text>
              ))}
            </Box>
          );
        }}
        multi={question.question.multiSelect === true}
        onPick={(indices) => {
          const labels = indices.map((i) => question.question.options[i]?.label ?? "");
          question.resolve(labels);
          dialogs.setQuestion(null);
          dialogs.pushBlock({
            kind: "info",
            text: `→ 已选：${labels.length > 0 ? labels.join("、") : "（未选择）"}`,
          });
        }}
        onCancel={() => {
          question.resolve([]);
          dialogs.setQuestion(null);
          dialogs.pushBlock({ kind: "info", text: "→ 已选：（未选择）" });
        }}
      />
    </Box>
  );
}
