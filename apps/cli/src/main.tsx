import { render } from "ink";
import { join } from "node:path";
import { EncryptedFileKeychain } from "@kcode/platform";
import {
  installPlugin,
  listInstalledPlugins,
  uninstallPlugin,
} from "@kcode/extensions";
import { ensureDaemon, killDaemonByPidfile } from "./daemon-client.js";
import { loadUserConfig, kcodeHome, requireDefaultModelRef } from "./bootstrap.js";
import { KcodeApp } from "./tui/App.js";

/** key 录入子命令：直接操作本地加密文件（不经过守护进程） */
async function keyCommand(args: string[]): Promise<void> {
  const [op, ref, key, ...audiences] = args;
  const keychain = EncryptedFileKeychain.fromEnv(join(kcodeHome(), "keys.json"));
  if (op === "add" && ref !== undefined && key !== undefined && audiences.length > 0) {
    await keychain.set(ref, key, audiences);
    console.log(`已录入 ${ref}（受众：${audiences.join(", ")}）`);
    // daemon 在启动时解密并缓存 keychain——磁盘更新后必须换新进程才生效
    if (killDaemonByPidfile()) {
      console.log("已结束旧守护进程：下次启动 kcode 将使用新 key");
    }
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

/** 隐藏回显的口令输入（raw mode 逐字符收集，回车结束；Ctrl+C 退出） */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY !== true) {
      resolve("");
      return;
    }
    process.stdout.write(label);
    const chars: string[] = [];
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      if (s === "\r" || s === "\n") {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("\n");
        resolve(chars.join(""));
        return;
      }
      if (s === "\u0003") {
        process.stdout.write("\n");
        process.exit(130);
      }
      // 方向键等功能键是 ESC 起头的转义序列、Tab 等控制字符——不进口令
      if (s.charCodeAt(0) === 0x1b || s === "\t" || s.charCodeAt(0) < 0x20) {
        return;
      }
      if (s === "\u007f" || s === "\b") {
        chars.pop();
        return;
      }
      chars.push(s);
    };
    stdin.on("data", onData);
  });
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

  // 提前预警：配置了需要 key 的 provider 但当前终端没设口令——
  // daemon 继承本终端环境，此刻启动必然在会话创建时报 keychain 错
  const needsKey = Object.values(models.providers ?? {}).some(
    (p) => p.type !== "gateway" && p.keyRef !== undefined,
  );
  if (needsKey && (process.env["KCODE_KEYCHAIN_PASSPHRASE"] ?? "") === "") {
    if (process.stdin.isTTY === true) {
      // 交互终端：直接询问口令（不回显）并立即用 keys.json 校验，错了当场重试
      let verified = false;
      for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
        const pass = await promptHidden(
          `未检测到 KCODE_KEYCHAIN_PASSPHRASE，请输入 keychain 口令（不回显，${attempt}/3，回车确认）：`,
        );
        if (pass === "") {
          console.error("⚠ 未输入口令：需要 API key 的模型将无法使用");
          break;
        }
        process.env["KCODE_KEYCHAIN_PASSPHRASE"] = pass;
        try {
          // 本进程直接试解密：口令对不对当场知道，不等会话创建才炸
          const kc = EncryptedFileKeychain.fromEnv(join(kcodeHome(), "keys.json"));
          await kc.list();
          verified = true;
        } catch {
          console.error("✗ 口令校验失败：与 keys.json 的加密口令不一致");
        }
      }
      if (!verified && (process.env["KCODE_KEYCHAIN_PASSPHRASE"] ?? "") !== "") {
        console.error(
          "口令三次校验失败。若忘记原口令，重置方法（注意：会清除已录的 key，需要重新录入）：\n" +
            '  1) set KCODE_KEYCHAIN_PASSPHRASE=新口令\n' +
            "  2) del \"%USERPROFILE%\\.kcode\\keys.json\"\n" +
            "  3) npx tsx src/main.tsx key add keychain://glm <你的API key> https://open.bigmodel.cn/api/paas/v4",
        );
        process.exit(1);
      }
      if (verified) {
        // 现有 daemon 可能是「无口令/错口令」环境拉起的——握手只比对有无，比对不了对错；
        // 交互取得正确口令后主动换新 daemon，确保以本环境拉起
        killDaemonByPidfile();
      }
    } else {
      console.error(
        "⚠ 当前终端未设置 KCODE_KEYCHAIN_PASSPHRASE：需要 API key 的模型将无法使用。\n" +
          '  PowerShell：$env:KCODE_KEYCHAIN_PASSPHRASE="你的口令"；cmd：set KCODE_KEYCHAIN_PASSPHRASE=你的口令',
      );
    }
  }

  const client = await ensureDaemon();
  console.error(`已连接守护进程（模型 ${modelRef}）`);

  if (process.stdout.isTTY !== true) {
    // 输出经管道（如 pnpm --filter 转发）时 Ink 无法局部刷新，帧会逐行堆积刷屏
    console.error(
      "提示：当前 stdout 非直接终端，动态界面可能反复刷屏；建议直接运行：cd apps/cli && npx tsx src/main.tsx",
    );
  } else if (process.platform === "win32" && process.env["WT_SESSION"] === undefined && process.env["TERM_PROGRAM"] === undefined) {
    // 老式 conhost 可能未启用 VT 转义序列：Ink 无法擦除旧帧，会整段重复打印
    console.error(
      "提示：检测到非 Windows Terminal / VS Code 终端，若界面出现整段重复，请改用 Windows Terminal 或 VS Code 集成终端运行",
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
