import { render } from "ink";
import { join } from "node:path";
import type { ChatMessage } from "@kcode/contracts";
import { listSessions, loadSessionEvents, rebuildHistory } from "@kcode/runtime";
import { EncryptedFileKeychain } from "@kcode/platform";
import { bootstrap, kcodeHome, requireDefaultModelRef } from "./bootstrap.js";
import { KcodeApp } from "./tui/App.js";

async function keyCommand(args: string[]): Promise<void> {
  const [op, ref, key, ...audiences] = args;
  const keychain = EncryptedFileKeychain.fromEnv(join(kcodeHome(), "keys.json"));
  if (op === "add" && ref !== undefined && key !== undefined && audiences.length > 0) {
    await keychain.set(ref, key, audiences);
    console.log(`已录入 ${ref}（受众：${audiences.join(", ")}）`);
    return;
  }
  if (op === "list") {
    for (const r of await keychain.list()) {
      const entry = await keychain.get(r);
      console.log(`${r} → ${entry?.audiences.join(", ") ?? ""}`);
    }
    return;
  }
  throw new Error("用法：kcode key add <ref> <key> <audience...> ｜ kcode key list");
}

async function main(): Promise<void> {
  const [, , ...rest] = process.argv;
  if (rest[0] === "key") {
    await keyCommand(rest.slice(1));
    return;
  }

  // 参数解析：--image/-i <path> 可多次；--resume/-r <sessionId|latest>；剩余非-flag 词拼为一次性提问
  const images: string[] = [];
  const words: string[] = [];
  let resumeArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--image" || arg === "-i") {
      const p = rest[i + 1];
      if (p !== undefined) {
        images.push(p);
        i += 1;
      }
    } else if (arg === "--resume" || arg === "-r") {
      const p = rest[i + 1];
      if (p !== undefined) {
        resumeArg = p;
        i += 1;
      }
    } else {
      words.push(arg);
    }
  }
  const oneShot = words.length > 0 ? words.join(" ") : undefined;

  // 续接历史会话（§5.3）：新会话作为旧会话的分支
  let resumeFrom: ChatMessage[] | undefined;
  if (resumeArg !== undefined) {
    const summaries = await listSessions(join(kcodeHome(), "cli", "sessions"));
    if (summaries.length === 0) {
      throw new Error("无历史会话可续接（~/.kcode/cli/sessions 为空）");
    }
    const target =
      resumeArg === "latest"
        ? summaries[0]
        : summaries.find((s) => s.sessionId === resumeArg || s.sessionId.startsWith(resumeArg));
    if (target === undefined) {
      throw new Error(
        `未找到会话 "${resumeArg}"；最近会话：${summaries
          .slice(0, 5)
          .map((s) => s.sessionId)
          .join("、")}`,
      );
    }
    const events = await loadSessionEvents(target.filePath);
    resumeFrom = rebuildHistory(events);
    console.error(`⏪ 已续接 ${target.sessionId}（${target.turns} 轮 → ${resumeFrom.length} 条历史）`);
  }

  const rt = await bootstrap();
  const modelRef = requireDefaultModelRef(rt.models);
  const llm = await rt.router.resolve(modelRef);

  // P1-5/P1-6 Ink TUI：流式 / 工具状态 / y-N 确认 / Todo / 结构化提问 / 计划模式 / --image 附图
  //（需 Windows Terminal，§6）
  const { waitUntilExit } = render(
    <KcodeApp
      llm={llm}
      model={modelRef}
      cwd={process.cwd()}
      oneShot={oneShot}
      images={images.length > 0 ? images : undefined}
      resumeFrom={resumeFrom}
    />,
  );
  await waitUntilExit();
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
