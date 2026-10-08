import { useState } from "react";
import { Text, useInput } from "ink";
import { previousBoundary } from "../terminal/width.js";
import { c } from "../theme/theme.js";

/** 隐藏回显输入（API key / 口令）。空输入时退格 = 上一步（onBack 可选） */
export function HiddenInput(props: {
  label: string;
  onDone: (v: string) => void;
  onCancel: () => void;
  /** 空输入退格回退（向导上一步；首步不传即无操作） */
  onBack?: () => void;
}) {
  const [value, setValue] = useState("");
  useInput((ch, key) => {
    if (key.return) {
      props.onDone(value);
      return;
    }
    if (key.escape) {
      props.onCancel();
      return;
    }
    if ((key.backspace || key.delete) && value === "" && props.onBack !== undefined) {
      props.onBack();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((s) => s.slice(0, previousBoundary(s, s.length)));
      return;
    }
    if (ch !== undefined && ch !== "" && ch >= " ") {
      setValue((s) => s + ch);
    }
  });
  return (
    <Text>
      <Text color={c("accent")}>{props.label}</Text>
      {"•".repeat(value.length)}
    </Text>
  );
}
