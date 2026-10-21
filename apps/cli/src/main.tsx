import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  initUserConfig,
  loadProjectConfig,
  loadUserConfig,
  kcodeHome,
  resolveModelOverride,
} from "./bootstrap.js";
import { KcodeApp } from "./tui/App.js";
import { mergeStdinPrompt, parseCliArgs, UsageError, usageText } from "./args.js";
import { doctorCommand } from "./doctor.js";
import { mcpCommand } from "./mcp-cmd.js";
import { runHeadless } from "./headless.js";
import { commandsListCommand, skillsListCommand } from "./inspect.js";
import { runDataCommand } from "./data-commands.js";
import { updateCommand } from "./update.js";
/** 子命令与启动期输出出口：console 被 lint 全面禁用（no-console），这里是 CLI 界面直写而非日志 */
const print = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const printErr = (s: string): void => {
  process.stderr.write(`${s}\n`);
};
/** 2-11：顶层错误归类（参数/配置 2、认证 3、模型 API 4、其余 1） */
function exitCodeForError(err: unknown): number {
  if (err instanceof UsageError) return 2;
  const message = err instanceof Error ? err.message : String(err);
  if (/(401|403|unauthori[sz]ed|invalid[^\n]*key|keychain|KCODE_KEYCHAIN|认证|鉴权)/i.test(message)) {
    return 3;
  }
  if (/(参数|配置|--\w|不存在|不合法|未配置|需要配合)/.test(message)) return 2;
  if (/(429|5\d\d|timeout|timed out|ECONN|ENOTFOUND|fetch failed|模型|provider)/i.test(message)) {
    return 4;
  }
  return 1;
}

/** 2-08：一次性读尽管道 stdin（TTY 不调用） */
async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** key 录入子命令：直接操作本地加密文件（平台能力经 IPlatformService 注入，N2-1） */
async function keyCommand(platform: IPlatformService, args: string[]): Promise<void> {
  const [op, ref, ...rest] = args;
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
  if (op === "add") {
    if (ref === undefined) {
      throw new UsageError("用法：kcode key add <ref> <audience...> [--key-file <path>]");
    }
    // 2-18：key 不接受位置参数（会进 shell 历史/进程列表）；只允许隐藏输入或 --key-file
    let keyFile: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--key-file") {
        const value = rest[i + 1];
        if (value === undefined || value === "") {
          throw new UsageError("--key-file 需要一个文件路径");
        }
        keyFile = value;
        i += 1;
      } else {
        positional.push(rest[i]!);
      }
    }
    if (positional.length === 0) {
      throw new UsageError("用法：kcode key add <ref> <audience...> [--key-file <path>]");
    }
    if (positional.some((a) => !/^https?:\/\//i.test(a))) {
      throw new UsageError(
        "检测到疑似把 API key 放在命令行：请改用隐藏输入，或 --key-file <path>；受众应为 http(s) URL",
      );
    }
    const key =
      keyFile !== undefined
        ? (await readFile(keyFile, "utf8")).trim()
        : (await promptHidden("请输入 API key（不回显，回车确认）：")).trim();
    if (key === "") {
      throw new UsageError("未读取到 API key（非 TTY 请使用 --key-file <path>）");
    }
    await keychain.set(ref, key, positional);
    print(`已录入 ${ref}（受众：${positional.join(", ")}）`);
    return;
  }
  if (op === "list") {
    for (const r of await keychain.list()) {
      const entry = await keychain.get(r);
      print(`${r} → ${entry?.audiences.join(", ") ?? ""}`);
    }
    return;
  }
  throw new UsageError("用法：kcode key add <ref> <audience...> [--key-file <path>] ｜ kcode key list");
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

async function main(): Promise<void> {  const [, , ...rest] = process.argv;
  // 发行链（N2-4）：--version 由构建注入（tsup define），开发态显示 dev
  if (rest[0] === "--version" || rest[0] === "-v") {
    print(`kcode ${process.env["KCODE_VERSION"] ?? "dev"}（${process.platform}-${process.arch}，Node ${process.versions.node}）`);
    return;
  }
  // P0-0：顶层 `kcode login` 启动即打开登录向导（等价于 TUI 内 /login）
  const loginRequested = rest[0] === "login";
  // 2-04：解析/帮助先于任何 IO（平台服务、配置、keychain）
  const args = parseCliArgs(loginRequested ? rest.slice(1) : rest);
  if (args.help) {
    print(usageText());
    return;
  }
  const platform = createCliPlatformService();
  if (args.command !== undefined) {
    const { kind, args: sub } = args.command;
    if (kind === "init") {
      const settingsAt = sub.indexOf("--settings");
      const settingsPath = settingsAt >= 0 ? sub[settingsAt + 1] : undefined;
      const { created } = await initUserConfig(settingsPath);
      if (created) {
        print("✓ 已创建 ~/.kcode/config.json（空 providers）");
      } else {
        print("• ~/.kcode/config.json 已存在，未覆盖");
      }
      print("下一步：启动 kcode 后输入 /login 配置厂商与 API key。");
      return;
    }
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
    if (kind === "mcp") {
      process.exit((await mcpCommand(sub, print)) ? 0 : 1);
    }
    if (kind === "update") {
      process.exit((await updateCommand(sub, print)) ? 0 : 1);
    }
    if (kind === "sessions" || kind === "export") {
      process.exit((await runDataCommand(kind, process.cwd(), kcodeHome(), sub, print)) ? 0 : 1);
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
  let oneShot = args.prompt ?? args.positionalPrompt;
  const machineFormat = args.outputFormat === "json" || args.outputFormat === "stream-json";
  if ((args.json || machineFormat) && oneShot === undefined) {
    throw new UsageError(`--json/--output-format 需要配合提问使用（-p "..." 或位置参数）\n${usageText()}`);
  }
  // 2-08：管道输入作为上下文；`-p -` 直接把整段 stdin 当 prompt
  if (args.prompt !== undefined && process.stdin.isTTY !== true) {
    const stdinText = await readStdinText();
    oneShot = mergeStdinPrompt(stdinText, oneShot ?? "");
  } else if (args.prompt === "-") {
    throw new UsageError("-p - 需要从管道/heredoc 提供输入（当前 stdin 是终端）");
  }

  if (process.stdin.isTTY !== true && oneShot === undefined) {
    // 无 TTY 且无提问：打印用法退出，而不是挂着等不可能到来的输入
    print(`kcode —— 本地优先代码助手\n${usageText()}\n交互界面需要终端（TTY）；脚本/管道模式请附带提问或 -p。`);
    process.exit(0);
  }

  // 模型引用仅作显示与传递，实际供给由 providers 路由解析（含受众绑定校验）；
  // --model（N3F-5 第四层）覆盖三层配置，TUI 与 headless 同一生效点
  // 2-06：--settings 覆盖用户级配置；项目层只提供 default/mode
  const models = await loadUserConfig(args.settings, { cwd: process.cwd() });
  const project = await loadProjectConfig(process.cwd());
  // 2-01：没有 default 也进 TUI（未配置模式）；headless 需要真实模型，下面单独拦
  const modelRef =
    args.model !== undefined ? resolveModelOverride(models, args.model) : (models.default ?? "");
  if (args.verbose) {
    printErr(
      `[verbose] kcode ${process.env["KCODE_VERSION"] ?? "dev"} · ${process.platform}-${process.arch} · node ${process.versions.node}\n` +
        `[verbose] cwd=${process.cwd()} settings=${args.settings ?? "~/.kcode/config.json"} model=${modelRef === "" ? "（未配置）" : modelRef}\n` +
        `[verbose] mode=${args.mode ?? project.mode ?? "default"} output=${args.outputFormat ?? "text"} providers=${Object.keys(models.providers ?? {}).join(",") || "（空）"}`,
    );
  }

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
            "  3) kcode key add keychain://glm https://open.bigmodel.cn/api/paas/v4（隐藏输入 API key，任意目录可执行）",
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
  const runtime: Runtime = await bootstrap(
    args.settings !== undefined ? { settingsPath: args.settings } : {},
  );

  // headless（N3C-1 / 2-07）：--json、显式 -p（默认恒无头）、或"非 TTY 且带提问"
  const promptIsHeadless = args.prompt !== undefined && !args.interactive;
  if (machineFormat || args.json || promptIsHeadless || (oneShot !== undefined && process.stdin.isTTY !== true)) {
    if (modelRef === "") {
      throw new Error("未配置模型：请先运行 kcode init，再在交互界面输入 /login 配置厂商与 key");
    }
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
        ...(args.outputFormat !== undefined ? { outputFormat: args.outputFormat } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
        ...(args.ephemeral ? { ephemeral: true } : {}),
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      },
      print,
      // 流式增量不加换行直写 stdout（print 会逐次补 \n，正文会被切碎）
      (chunk) => process.stdout.write(chunk),
    );
    process.exit(code);
  }
  // 2-09：--mode / 项目 mode 在 TUI 生效；fullAccess 不能在启动时静默授予
  const requestedMode = args.mode ?? project.mode;
  if (requestedMode === "fullAccess") {
    if (args.mode === "fullAccess") {
      throw new UsageError("--mode fullAccess 需进入 TUI 后输入 /mode fullAccess 显式确认");
    }
    printErr("⚠ 项目配置请求 fullAccess 已忽略：交互态请用 /mode fullAccess 显式确认");
  }
  const initialMode = requestedMode === "fullAccess" ? undefined : requestedMode;

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
      forkFrom={args.fork}
      initialMode={initialMode}
      disallowedTools={args.disallowedTools}
      initialLogin={loginRequested}
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
  const code = exitCodeForError(err);
  printErr(`✗ ${err instanceof Error ? err.message : String(err)}`);
  // 2/3/4 是可操作错误，不打栈；只有未归因的 1 留现场
  if (code === 1 && err instanceof Error && err.stack !== undefined) {
    printErr(err.stack);
    try {
      appendFileSync(join(homedir(), "kcode-crash.log"), `${new Date().toISOString()}\n${err.stack}\n`, "utf8");
    } catch {}
  }
  process.exit(code);
});
