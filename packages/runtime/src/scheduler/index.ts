/**
 * 调度器（§5.5，ZCode 语义完整对齐）：cron 5 字段本地时区 / delayMinutes 一次性 /
 * intervalUnit+interval(1–200) 周期 / maxRuns 有限次数 / SQLite 持久化 workspace 作用域。
 * P5 落地；headless 到期会话用 automation 权限模式（ask → deny + 记录 + 通知）。
 */
export interface ScheduleSpec {
  id: string;
  workspaceId: string;
  cron?: string;
  delayMinutes?: number;
  intervalUnit?: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  maxRuns?: number;
}

export interface SchedulerPort {
  create(spec: ScheduleSpec): Promise<void>;
  cancel(id: string): Promise<void>;
}
