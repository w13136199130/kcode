import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig, type Options } from "tsup";

/**
 * N2-4 发行链：CLI 打包为可独立运行的产物（esbuild 全量 bundle——workspace 包与
 * npm 依赖一并打入，运行环境只需 Node ≥22，不装依赖、不用 tsx）。例外与伴生资产：
 * - canvas：pdfjs-dist 可选渲染后端（extract 只取文本层），运行时按需 require、缺省即跳过
 * - react-devtools-core：ink 调试依赖（顶层静态引入）——esbuild 插件桩替换
 * - yoga.wasm：yoga-layout 运行时 require("./yoga.wasm")——平铺到产物旁
 * - @vscode/ripgrep（+平台二进制包）：grep 捆绑的 rg——外部化并复制到 dist/node_modules 随包分发
 */
const devtoolsStub: NonNullable<Options["esbuildPlugins"]>[number] = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "kcode-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "kcode-stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

const version = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;

export default defineConfig({
  entry: { kcode: "src/main.tsx" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  banner: {
    js: [
      "#!/usr/bin/env node",
      // esbuild ESM 输出里 CJS 依赖的 require(node 内建) 会走抛错 shim——
      // 注入 createRequire 让 shim 回退到真 require（单文件 bundle 的标准解法）
      "import { createRequire as __kcodeCreateRequire } from 'node:module';",
      "const require = __kcodeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  noExternal: [/^(?!canvas($|\/)|react-devtools-core($|\/)|@vscode\/ripgrep($|\/))/],
  external: ["canvas", "@vscode/ripgrep"],
  esbuildPlugins: [devtoolsStub],
  outExtension: () => ({ js: ".mjs" }),
  define: { "process.env.KCODE_VERSION": JSON.stringify(version) },
  esbuildOptions: (options) => {
    options.jsx = "automatic";
  },
  onSuccess: async () => {
    // exports 映射普遍不暴露 ./package.json 子路径：解析主入口后向上找包根
    const pkgRoot = (req: Node.Require, id: string): string => {
      let dir = dirname(req.resolve(id));
      while (!existsSync(join(dir, "package.json"))) {
        dir = dirname(dir);
      }
      return dir;
    };
    // ripgrep 从依赖它的 @kcode/tools 解析（pnpm 严格布局下 CLI 侧不可见）
    const toolsReq = createRequire(resolve("../../packages/tools/package.json"));
    const rgRoot = pkgRoot(toolsReq, "@vscode/ripgrep");
    await mkdir("dist/node_modules/@vscode", { recursive: true });
    rmSync(join("dist", "node_modules", "@vscode", "ripgrep"), { recursive: true, force: true });
    await cp(rgRoot, join("dist", "node_modules", "@vscode", "ripgrep"), { recursive: true });

    // 平台二进制：pnpm 用 junction 链到独立 store，整目录复制会被套娃绊倒——
    // 直接定位 rg 可执行文件本身，在产物里自建最小包（自写 package.json 保证子路径可解析）
    const platformName = `ripgrep-${process.platform}-${process.arch}`;
    const exe = process.platform === "win32" ? "rg.exe" : "rg";
    const findRgBinary = (): string => {
      const siblingBin = join(dirname(rgRoot), platformName, "bin", exe);
      if (existsSync(siblingBin)) {
        return siblingBin;
      }
      const storeDir = dirname(dirname(dirname(dirname(rgRoot))));
      if (basename(storeDir) === ".pnpm") {
        const found = readdirSync(storeDir).find((d) => d.startsWith(`@vscode+${platformName}@`));
        if (found !== undefined) {
          const candidate = join(storeDir, found, "node_modules", "@vscode", platformName, "bin", exe);
          if (existsSync(candidate)) {
            return candidate;
          }
        }
      }
      throw new Error(`未找到 rg 二进制（@vscode/${platformName}/bin/${exe}，构建机需先 pnpm install）`);
    };
    await mkdir(join("dist", "node_modules", "@vscode", platformName, "bin"), { recursive: true });
    await copyFileSync(findRgBinary(), join("dist", "node_modules", "@vscode", platformName, "bin", exe));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join("dist", "node_modules", "@vscode", platformName, "package.json"),
      `${JSON.stringify({ name: `@vscode/${platformName}`, version: "1.18.0", private: true }, null, 2)}
`,
    );

    // yoga.wasm 平铺到产物旁（require("./yoga.wasm") 相对解析；yoga-wasm-web 随 ink 进 CLI 依赖）
    const yogaRoot = pkgRoot(createRequire(resolve("package.json")), "yoga-wasm-web");
    await copyFileSync(join(yogaRoot, "dist", "yoga.wasm"), "dist/yoga.wasm");
  },
});
