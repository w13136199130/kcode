import { upsertSessionIndex } from "../../src/session-index.ts";

const [home, prefix, rawCount] = process.argv.slice(2);
const count = Number(rawCount ?? "0");
if (home === undefined || prefix === undefined || !Number.isInteger(count)) {
  process.exit(2);
}
for (let i = 0; i < count; i++) {
  await upsertSessionIndex(home, {
    sessionId: `${prefix}_${String(i).padStart(3, "0")}`,
    workspaceKey: "E:/space/lock-test",
    status: "active",
  });
}
