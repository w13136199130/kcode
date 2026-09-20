import { render } from "ink";
import { join } from "node:path";
import { EncryptedFileKeychain } from "@kcode/platform";
import { ensureDaemon } from "./daemon-client.js";
import { loadUserConfig, kcodeHome, requireDefaultModelRef } from "./bootstrap.js";
import { KcodeApp } from "./tui/App.js";

/** key 录入子命令：直接操作本地加密文件（不经过守护进程） */
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

  // 模型引用仅作显示与传递，实际供给由守护进程解析（含受众绑定校验）
  const models = await loadUserConfig();
  const modelRef = requireDefaultModelRef(models);

  const client = await ensureDaemon();
  console.error(`已连接守护进程（模型 ${modelRef}）`);

  const { waitUntilExit } = render(
    <KcodeApp
      client={client}
      model={modelRef}
      cwd={process.cwd()}
      oneShot={oneShot}
      images={images.length > 0 ? images : undefined}
      resumeFrom={resumeArg}
    />,
  );
  await waitUntilExit();
  client.close();
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
