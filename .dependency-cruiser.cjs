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
      comment:
        "规则3：P0 允许 core 引用能力层【类型】（不得调用其 IO 实现），上线 P1 前清零本警告",
      severity: "warn",
      from: { path: "^packages/core" },
      to: { path: "^packages/(tools|runtime|extensions|platform)" },
    },
    {
      name: "apps-import-packages",
      comment:
        "规则4：cli 单进程直接组装 packages（C 级单进程化，daemon 已剔除）——保持 warn 以监控依赖面，不阻断；web/market 只经 relay 通信（P4）",
      severity: "warn",
      from: { path: "^apps/(cli|web|market)" },
      to: { path: "^packages/" },
    },
    {
      name: "no-circular",
      severity: "warn",
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
