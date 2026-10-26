import { test } from "@playwright/test";

// 调试用探针（定位 desktop-v2 回归已完成，保留跳过用例避免空 spec 报错）。
// 需要复跑诊断时恢复为完整版本（git 历史中有）。
test.skip("probe: 发送→等空闲→新建→转储状态（已停用）", () => {});
