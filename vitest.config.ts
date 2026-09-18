import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // 测试运行期把 workspace 包指向 TS 源码（exports 同样指向 src，这里仅为绕开
    // vite 对 node_modules 路径的外部化；tsc 仍按真实 exports + NodeNext 校验）
    alias: [
      {
        find: /^@kcode\/(contracts|shared|core|tools|runtime|extensions|platform)$/,
        replacement: `${root}packages/$1/src/index.ts`,
      },
    ],
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.tsx",
      "evals/test/**/*.test.ts",
    ],
    server: {
      deps: {
        // 内联 workspace 符号链接包（匹配解析后的路径段，而非裸包名）
        inline: [/[/\\]@kcode[/\\]/],
      },
    },
  },
});
