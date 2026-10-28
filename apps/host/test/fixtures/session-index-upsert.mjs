import { upsertSessionIndex } from "../../src/session-index.ts";

const [home, prefix, rawCount] = process.argv.slice(2);
const count = Number(rawCount ?? "0");
if (home === undefined || prefix === undefined || !Number.isInteger(count)) {
  process.exit(2);
}
for (let i = 0; i < count; i++) {
  // CI 慢机双进程抢锁激烈：锁忙（等待超时）按退避重试——本用例聚焦
  // “并发 upsert 不丢更新”，锁的等待/接管/拒绝语义由另两个用例覆盖。
  for (let attempt = 0; ; attempt++) {
    try {
      await upsertSessionIndex(home, {
        sessionId: `${prefix}_${String(i).padStart(3, "0")}`,
        workspaceKey: "E:/space/lock-test",
        status: "active",
      });
      break;
    } catch (err) {
      const busy = String(err instanceof Error ? err.message : err).includes("锁等待超时");
      if (!busy || attempt >= 20) process.exit(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
