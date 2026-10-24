import { Bug, FileDiff, Folder, Search } from "lucide-react";

const PROMPTS = [
  {
    icon: Search,
    title: "理解这个仓库",
    desc: "架构、入口、关键模块",
    text: "请先阅读这个仓库，说明它的架构、入口和关键模块。",
  },
  {
    icon: Bug,
    title: "修复一个 bug",
    desc: "定位、修改、验证",
    text: "请帮我定位并修复这个仓库里的一个 bug。先说明你准备怎么排查。",
  },
  {
    icon: FileDiff,
    title: "生成变更摘要",
    desc: "diff、测试、风险",
    text: "请生成当前变更的摘要，说明 diff、测试结果和风险。",
  },
] as const;

/** 空会话主区：原型式“开始一个任务”入口。 */
export function EmptyState(props: {
  cwd: string;
  onPick(text: string): void;
}) {
  const name = props.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "当前工作区";
  return (
    <div className="empty-v2">
      <div className="empty-kicker"><span className="empty-logo">k</span>KCODE WORKSPACE</div>
      <h1>开始一个任务</h1>
      <p>读代码、改实现、跑测试，或者把一堆材料整理成可交付的结果。</p>
      <div className="empty-prompts">
        {PROMPTS.map((prompt) => {
          const Icon = prompt.icon;
          return (
            <button type="button" className="empty-prompt" key={prompt.title} onClick={() => props.onPick(prompt.text)}>
              <Icon size={16} strokeWidth={1.7} />
              <strong>{prompt.title}</strong>
              <span>{prompt.desc}</span>
            </button>
          );
        })}
      </div>
      <div className="empty-recent">
        <span>当前工作区</span>
        <span className="empty-project"><Folder size={13} strokeWidth={1.7} />{name}</span>
      </div>
    </div>
  );
}
