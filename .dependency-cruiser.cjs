/** §4.2 依赖规则（CI 门禁）——见 ARCHITECTURE.md */
module.exports = {
  forbidden: [
    {
      name: "capability-cross-import-tools",
      comment: "规则1：能力层互引禁止（tools 不得 import runtime/extensions/platform）",
      severity: "error",
      from: { path: "^packages/tools" },
      to: { path: "^packages/(runtime|extensions|platform)" },
    },
    {
      name: "capability-cross-import-runtime",
      severity: "error",
      from: { path: "^packages/runtime" },
      to: { path: "^packages/(tools|extensions|platform)" },
    },
    {
      name: "capability-cross-import-extensions",
      severity: "error",
      from: { path: "^packages/extensions" },
      to: { path: "^packages/(tools|runtime|platform)" },
    },
    {
      name: "capability-cross-import-platform",
      severity: "error",
      from: { path: "^packages/platform" },
      to: { path: "^packages/(tools|runtime|extensions)" },
    },
    {
      name: "no-reverse-to-engine",
      comment: "规则2：任何包不得反向依赖引擎层（core）",
      severity: "error",
      from: { path: "^packages/(tools|runtime|extensions|platform|contracts|shared)" },
      to: { path: "^packages/core" },
    },
    {
      name: "base-purity",
      comment: "底座（contracts/shared）不得依赖上层任何包",
      severity: "error",
      from: { path: "^packages/(contracts|shared)" },
      to: { path: "^packages/(core|tools|runtime|extensions|platform)" },
    },
    {
      name: "engine-to-capability",
      comment: "规则3：core 不得引用能力层实现（类型经 contracts 接口消费）",
      severity: "error",
      from: { path: "^packages/core" },
      to: { path: "^packages/(tools|runtime|extensions|platform)" },
    },
    {
      name: "apps-import-packages",
      comment:
        "规则4（N2-5 升 error）：app 只经包的公开入口（src/index.ts）消费 packages——cli 单进程组装允许 import 包，但深路径（包内部文件）禁止，跨包边界从入口收敛",
      severity: "error",
      from: { path: "^apps/" },
      to: {
        path: "^packages/[^/]+/src/",
        pathNot: "^packages/[^/]+/src/index\\.ts$",
      },
    },
    {
      name: "ui-no-platform-impl",
      comment:
        "规则5（N2-1）：UI 与入口不直接依赖平台实现——平台能力只经 contracts.IPlatformService 注入；装配点 bootstrap.ts 是唯一豁免",
      severity: "error",
      from: { path: "^apps/cli/src/(tui|main)" },
      to: { path: "^packages/platform" },
    },
    {
      name: "no-circular",
      comment: "任何包之间禁止循环依赖",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["types", "import"],
    },
  },
};
