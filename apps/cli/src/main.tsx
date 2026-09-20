import { render } from "ink";
import { join } from "node:path";
import { EncryptedFileKeychain } from "@kcode/platform";
import {
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
} from "@kcode/extensions";
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

/** 插件管理子命令：install/list/remove（本地目录安装，市场在后续版本接入） */
async function pluginCommand(args: string[]): Promise<void> {
  const cacheDir = join(kcodeHome(), "cli", "plugins", "cache");
  const [op, ...rest] = args;

  if (op === "install" && rest[0] !== undefined) {
    const result = await installPlugin(rest[0], cacheDir, { force: rest.includes("--force") });
    console.log(`\n${result.consentSummary}\n`);
    console.log(`已安装 ${result.name}@${result.version} → ${result.installPath}`);
    console.log(`seed hash：${result.hash.slice(0, 16)}…`);
    return;
  }
  if (op === "list") {
    const plugins = await listInstalledPlugins(cacheDir);
    if (plugins.length === 0) {
      console.log("（暂无已安装插件）");
      return;
    }
    for (const p of plugins) {
      const skills = p.manifest.skills.length > 0 ? ` 技能×${p.manifest.skills.length}` : "";
      const hooks = p.manifest.hooks.length > 0 ? ` hooks×${p.manifest.hooks.length}` : "";
      const mcp = p.manifest.mcp.length > 0 ? ` MCP×${p.manifest.mcp.length}` : "";
      console.log(`${p.manifest.name}@${p.manifest.version}${skills}${hooks}${mcp}`);
    }
    return;
  }
  if (op === "remove" && rest[0] !== undefined) {
    // 支持 name 或 name@version
    const at = rest[0].indexOf("@");
    const name = at === -1 ? rest[0] : rest[0].slice(0, at);
    const version = at === -1 ? undefined : rest[0].slice(at + 1);
    console.log(await uninstallPlugin(cacheDir, name, version));
    return;
  }
  throw new Error("用法：kcode plugin install <目录> [--force] ｜ list ｜ remove <name>[@version]");
}

async function main(): Promise<void> {
  const [, , ...rest] = process.argv;
  if (rest[0] === "key") {
    await keyCommand(rest.slice(1));
    return;
  }
  if (rest[0] === "plugin") {
    await pluginCommand(rest.slice(1));
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

  if (process.stdout.isTTY !== true) {
    // 输出经管道（如 pnpm --filter 转发）时 Ink 无法局部刷新，帧会逐行堆积刷屏
    console.error(
      "提示：当前 stdout 非直接终端，动态界面可能反复刷屏；建议直接运行：cd apps/cli && npx tsx src/main.tsx",
    );
  }

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
