import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { render } from "ink";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  installPlugin,
  listInstalledPlugins,
  readDisabledPlugins,
  setPluginEnabled,
  uninstallPlugin,
  verifyPluginSeed,
} from "@kcode/extensions";
import type { IPlatformService } from "@kcode/contracts";
import { bootstrap, type Runtime } from "./bootstrap.js";
import {
  createCliPlatformService,
  loadUserConfig,
  kcodeHome,
  requireDefaultModelRef,
} from "./bootstrap.js";
import { KcodeApp } from "./tui/App.js";
import { parseCliArgs, usageText } from "./args.js";
import { doctorCommand } from "./doctor.js";
import { runHeadless } from "./headless.js";
import { commandsListCommand, skillsListCommand } from "./inspect.js";
import { updateCommand } from "./update.js";

/** 子命令与启动期输出出口：console 被 lint 全面禁用（no-console），这里是 CLI 界面直写而非日志 */
const print = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const printErr = (s: string): void => {
  process.stderr.write(`${s}\n`);
};

/** key 录入子命令：直接操作本地加密文件（平台能力经 IPlatformService 注入，N2-1） */
async function keyCommand(platform: IPlatformService, args: string[]): Promise<void> {
  const [op, ref, key, ...audiences] = args;
  // 环境无口令时交互式询问（set 只对当前窗口生效，新开窗口常见此况）
  const legacyKeysFile = join(kcodeHome(), "keys.json");
  const dpapiEligible = platform.secureStorageAvailable && !existsSync(legacyKeysFile);
  if ((process.env["KCODE_KEYCHAIN_PASSPHRASE"] ?? "") === "" && !dpapiEligible && process.stdin.isTTY === true) {
    const pass = await promptHidden("未检测到 KCODE_KEYCHAIN_PASSPHRASE，请输入 keychain 口令（不回显，回车确认）：");
    if (pass !== "") {
      process.env["KCODE_KEYCHAIN_PASSPHRASE"] = pass;
    }
  }
  const keychain = platform.openDefaultKeychain();
  if (op === "add" && ref !== undefined && key !== undefined && audiences.length > 0) {
    await keychain.set(ref, key, audiences);
    print(`已录入 ${ref}（受众：${audiences.join(", ")}）`);
    return;
  }
  if (op === "list") {
    for (const r of await keychain.list()) {
      const entry = await keychain.get(r);
      print(`${r} → ${entry?.audiences.join(", ") ?? ""}`);
    }
    return;
  }
  throw new Error("用法：kcode key add <ref> <key> <audience...> ｜ kcode key list");
}

/** 插件管理子命令：install/list/remove/enable/disable（本地目录安装，市场在后续版本接入） */
async function pluginCommand(args: string[]): Promise<void> {
  const pluginsDir = join(kcodeHome(), "cli", "plugins");
  const cacheDir = join(pluginsDir, "cache");
  const [op, ...rest] = args;

  if (op === "install" && rest[0] !== undefined) {
    const result = await installPlugin(rest[0], cacheDir, { force: rest.includes("--force") });
    print(`\n${result.consentSummary}\n`);
    print(`已安装 ${result.name}@${result.version} → ${result.installPath}`);
    print(`seed hash：${result.hash.slice(0, 16)}…`);
    return;
  }
  if (op === "list") {
    const plugins = await listInstalledPlugins(cacheDir);
    if (plugins.length === 0) {
      print("（暂无已安装插件）");
      return;
    }
    const disabled = new Set(await readDisabledPlugins(pluginsDir));
    for (const p of plugins) {
      const skills = p.manifest.skills.length > 0 ? ` 技能×${p.manifest.skills.length}` : "";
      const hooks = p.manifest.hooks.length > 0 ? ` hooks×${p.manifest.hooks.length}` : "";
      const mcp = p.manifest.mcp.length > 0 ? ` MCP×${p.manifest.mcp.length}` : "";
      // 完整性校验（N3-5）：与会话装载同一套判定，让"为什么没生效"在 list 就能看出来
      const tampered = !(await verifyPluginSeed(p.installPath, p.seed.hash));
      const off =
        tampered
          ? " ⚠ 完整性校验失败（会话拒绝装载）"
          : disabled.has(p.manifest.name) || disabled.has(`${p.manifest.name}@${p.manifest.version}`)
            ? " [已停用]"
            : "";
      print(`${p.manifest.name}@${p.manifest.version}${off}${skills}${hooks}${mcp}`);
    }
    return;
  }
  if (op === "remove" && rest[0] !== undefined) {
    // 支持 name 或 name@version
    const at = rest[0].indexOf("@");
    const name = at === -1 ? rest[0] : rest[0].slice(0, at);
    const version = at === -1 ? undefined : rest[0].slice(at + 1);
    print(await uninstallPlugin(cacheDir, name, version));
    return;
  }
  if ((op === "enable" || op === "disable") && rest[0] !== undefined) {
    // 停用只影响新会话的装载（本会话若在跑不受影响）
    await setPluginEnabled(pluginsDir, rest[0], op === "enable");
    print(op === "enable" ? `已启用 ${rest[0]}（新会话生效）` : `已停用 ${rest[0]}（新会话生效）`);
    return;
  }
  throw new Error(
    "用法：kcode plugin install <目录> [--force] ｜ list ｜ remove <name>[@version] ｜ enable|disable <name>[@version]",
  );
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
  // 发行链（N2-4）：--version 由构建注入（tsup define），开发态显示 dev
  if (rest[0] === "--version" || rest[0] === "-v") {
    print(`kcode ${process.env["KCODE_VERSION"] ?? "dev"}（${process.platform}-${process.arch}，Node ${process.versions.node}）`);
    return;
  }
  const platform = createCliPlatformService();
  const args = parseCliArgs(rest);
  if (args.command !== undefined) {
    const { kind, args: sub } = args.command;
    if (kind === "key") {
      await keyCommand(platform, sub);
      return;
    }
    if (kind === "plugin") {
      await pluginCommand(sub);
      return;
    }
    if (kind === "doctor") {
      process.exit((await doctorCommand(platform, print)) ? 0 : 1);
    }
    if (kind === "update") {
      process.exit((await updateCommand(sub, print)) ? 0 : 1);
    }
    if (kind === "skills") {
      if (sub[0] !== "list") {
        throw new Error("用法：kcode skills list");
      }
      await skillsListCommand(process.cwd(), kcodeHome(), print);
      return;
    }
    if (sub[0] !== "list") {
      throw new Error("用法：kcode commands list");
    }
    await commandsListCommand(process.cwd(), kcodeHome(), print);
    return;
  }

  // --cwd 先于一切 IO：后续 resume 作用域、trust、AGENTS/技能根都读 process.cwd()
  if (args.cwd !== undefined) {
    if (!existsSync(args.cwd)) {
      throw new Error(`--cwd 目录不存在：${args.cwd}`);
    }
    process.chdir(args.cwd);
  }
  const oneShot = args.prompt ?? args.positionalPrompt;
  if (args.json && oneShot === undefined) {
    throw new Error(`--json 需要配合提问使用（-p "..." 或位置参数）\n${usageText()}`);
  }

  if (process.stdin.isTTY !== true && oneShot === undefined) {
    // 无 TTY 且无提问：打印用法退出，而不是挂着等不可能到来的输入
    print(`kcode —— 本地优先代码助手\n${usageText()}\n交互界面需要终端（TTY）；脚本/管道模式请附带提问或 -p。`);
    process.exit(0);
  }

  // 模型引用仅作显示与传递，实际供给由 providers 路由解析（含受众绑定校验）
  const models = await loadUserConfig(undefined, { cwd: process.cwd() });
  const modelRef = requireDefaultModelRef(models);

  // 提前预警：配置了需要 key 的 provider 但当前终端没设口令——
  // 单进程直接继承本终端环境，此刻启动必然在会话创建时报 keychain 错
  const needsKey = Object.values(models.providers ?? {}).some(
    (p) => p.type !== "gateway" && p.keyRef !== undefined,
  );
  if (needsKey && (process.env["KCODE_KEYCHAIN_PASSPHRASE"] ?? "") === "" && !platform.secureStorageAvailable) {
    if (process.stdin.isTTY === true) {
      // 交互终端：直接询问口令（不回显）并立即用 keys.json 校验，错了当场重试
      let verified = false;
      for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
        const pass = await promptHidden(
          `未检测到 KCODE_KEYCHAIN_PASSPHRASE，请输入 keychain 口令（不回显，${attempt}/3，回车确认）：`,
        );
        if (pass === "") {
          printErr("⚠ 未输入口令：需要 API key 的模型将无法使用");
          break;
        }
        process.env["KCODE_KEYCHAIN_PASSPHRASE"] = pass;
        // 本进程直接试解密：口令对不对当场知道，不等会话创建才炸
        verified = await platform.verifyEnvPassphrase();
        if (!verified) {
          printErr("✗ 口令校验失败：与 keys.json 的加密口令不一致");
        }
      }
      if (!verified && (process.env["KCODE_KEYCHAIN_PASSPHRASE"] ?? "") !== "") {
        printErr(
          "口令三次校验失败。若忘记原口令，重置方法（注意：会清除已录的 key，需要重新录入）：\n" +
            '  1) set KCODE_KEYCHAIN_PASSPHRASE=新口令\n' +
            "  2) del \"%USERPROFILE%\\.kcode\\keys.json\"\n" +
            "  3) kcode key add keychain://glm <你的API key> https://open.bigmodel.cn/api/paas/v4（任意目录可执行）",
        );
        process.exit(1);
      }
      void 0;
    } else {
      printErr(
        "⚠ 当前终端未设置 KCODE_KEYCHAIN_PASSPHRASE：需要 API key 的模型将无法使用。\n" +
          '  PowerShell：$env:KCODE_KEYCHAIN_PASSPHRASE="你的口令"；cmd：set KCODE_KEYCHAIN_PASSPHRASE=你的口令',
      );
    }
  }

  // 单进程：引擎内嵌本进程组装（bootstrap → router/keychain），无守护进程
  const runtime: Runtime = await bootstrap();

  // headless（N3C-1）：--json 或"非 TTY 且带提问"——不渲染 Ink，stdout 走 NDJSON/单行摘要
  if (args.json || (oneShot !== undefined && process.stdin.isTTY !== true)) {
    const code = await runHeadless(
      runtime,
      modelRef,
      {
        prompt: oneShot!,
        ...(args.images.length > 0 ? { images: args.images } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.disallowedTools !== undefined ? { disallowedTools: args.disallowedTools } : {}),
        ...(args.resume !== undefined ? { resumeFrom: args.resume } : {}),
        json: args.json,
      },
      print,
    );
    process.exit(code);
  }
  if (args.mode !== undefined) {
    // --mode 语义依赖 headless 的"ask 即拒"降级；TUI 内档位切换走 /mode（含 fullAccess 确认闸）
    throw new Error("--mode 用于 headless（--json 或非 TTY 提问）；交互界面内请用 /mode 切换档位");
  }

  if (process.stdout.isTTY !== true) {
    // 输出经管道（如 pnpm --filter 转发）时 Ink 无法局部刷新，帧会逐行堆积刷屏
    printErr(
      "提示：当前 stdout 非直接终端，动态界面可能反复刷屏；建议直接运行：cd apps/cli && npx tsx src/main.tsx",
    );
  } else if (process.platform === "win32" && process.env["WT_SESSION"] === undefined && process.env["TERM_PROGRAM"] === undefined) {
    // 老式 conhost 可能未启用 VT 转义序列：Ink 无法擦除旧帧，会整段重复打印
    printErr(
      "提示：检测到非 Windows Terminal / VS Code 终端，若界面出现整段重复，请改用 Windows Terminal 或 VS Code 集成终端运行",
    );
  }

  // 调试：捕获每次实际写屏的帧（剥离转义后的末段）——定位"帧写了但显示不对"类问题
  if (process.env["KCODE_INPUT_DEBUG"] === "1") {
    const rawWrite = process.stdout.write.bind(process.stdout) as (
      chunk: unknown,
      ...rest: unknown[]
    ) => boolean;
    const wrapped = (chunk: unknown, ...rest: unknown[]): boolean => {
      try {
        const s = typeof chunk === "string" ? chunk : "";
        if (s.length > 20) {
          const stripped = s
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
            .replace(/\x1b[=>78]/g, "");
          appendFileSync(
            join(homedir(), "kcode-input.log"),
            `${Date.now()} WRITE len=${s.length} tail=${JSON.stringify(stripped.slice(-90))}\n`,
            "utf8",
          );
        }
      } catch {}
      return rawWrite(chunk, ...rest);
    };
    process.stdout.write = wrapped as typeof process.stdout.write;
  }

  // exitOnCtrlC=false：运行中 Ctrl+C = 中断、空闲双击 = 退出（自建 raw 层接管）
  const { waitUntilExit } = render(
    <KcodeApp
      runtime={runtime}
      model={modelRef}
      cwd={process.cwd()}
      oneShot={oneShot}
      images={args.images.length > 0 ? args.images : undefined}
      resumeFrom={args.resume}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
  void runtime;
}

// 进程级兜底：任何未捕获异常都写 ~/kcode-crash.log（拿不到现场的崩溃一次定位）
process.on("uncaughtException", (err) => {
  try {
    appendFileSync(
      join(homedir(), "kcode-crash.log"),
      `${new Date().toISOString()} UNCAUGHT\n${err.stack ?? String(err)}\n`,
      "utf8",
    );
  } catch {}
  printErr(`✗ ${err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  try {
    appendFileSync(
      join(homedir(), "kcode-crash.log"),
      `${new Date().toISOString()} UNHANDLED\n${
        reason instanceof Error ? reason.stack ?? reason.message : String(reason)
      }\n`,
      "utf8",
    );
  } catch {}
});

main().catch((err) => {
  printErr(`✗ ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack !== undefined) {
    printErr(err.stack);
    try {
      appendFileSync(join(homedir(), "kcode-crash.log"), `${new Date().toISOString()}\n${err.stack}\n`, "utf8");
    } catch {}
  }
  process.exit(1);
});
