import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { c } from "../theme/theme.js";

/** 带标签的文本输入（向导 baseURL/模型名） */
export function PromptInput(props: {
  label: string;
  initialValue: string;
  onDone: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initialValue);
  useInput((_ch, key) => {
    if (key.escape) {
      props.onCancel();
    }
  });
  return (
    <Box>
      <Text color={c("accent")}>{props.label}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={props.onDone} />
    </Box>
  );
}
