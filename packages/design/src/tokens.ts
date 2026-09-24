/**
 * 语义色令牌：只声明语义，不绑定具体色值。
 * 终端（ANSI）、Web/桌面（CSS 变量）各自映射为可用颜色——「共享语义，不共享像素」。
 */
export type SemanticColor =
  | "foreground" // 正文（终端下继承前景色，不指定）
  | "foregroundSubtle" // 次要/元数据
  | "brand" // 品牌强调（logo/主交互）
  | "accent" // 面板标题/思考等区块强调
  | "success"
  | "warning"
  | "destructive"
  | "info"
  | "diffAdded"
  | "diffRemoved"
  | "diffContext"
  | "interactionAsk" // 等待用户确认（提问）
  | "interactionConfirm"; // 等待用户确认（确认）
