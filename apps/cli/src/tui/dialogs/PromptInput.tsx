import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { c } from "../theme/theme.js";

/**
 * 带标签的文本输入（向导 baseURL/模型名），CC 对话框形态：
 * label 独立行 + 圆角边框输入盒（截图对标 /add-dir）。空输入时退格 = 上一步（onBack 可选）。
 */
export function PromptInput(props: {
  label: string;
  initialValue: string;
  /** 盒内空态占位（dim） */
  placeholder?: string;
  onDone: (v: string) => void;
  onCancel: () => void;
  /** 空输入退格回退（向导上一步；首步不传即无操作） */
  onBack?: () => void;
}) {
  const [value, setValue] = useState(props.initialValue);
  useInput((_ch, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    // 真实终端退格发 DEL()，Ink 归为 delete；InputBox 有 stdin 补丁转换而这里没有——两个都判
    if ((key.backspace || key.delete) && value === "" && props.onBack !== undefined) {
      props.onBack();
    }
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={c("accent")}>{props.label}</Text>
      <Box borderStyle="round" paddingX={1} width="100%">
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={props.onDone}
          placeholder={props.placeholder ?? ""}
        />
      </Box>
    </Box>
  );
}
