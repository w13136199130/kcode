import { render } from "ink";
import { join } from "node:path";
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
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "key") {
    await keyCommand(rest);
    return;
  }

  const rt = await bootstrap();
  const modelRef = requireDefaultModelRef(rt.models);
  const llm = await rt.router.resolve(modelRef);

  // P1-5 Ink TUI：流式输出 / 工具状态 / y-N 确认 / 后台任务通知（需 Windows Terminal，§6）
  const { waitUntilExit } = render(
    <KcodeApp llm={llm} model={modelRef} cwd={process.cwd()} oneShot={cmd} />,
  );
  await waitUntilExit();
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
