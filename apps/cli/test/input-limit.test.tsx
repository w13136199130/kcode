import { EventEmitter } from "node:events";
import { useInput, useStdin, render as renderInk } from "ink";
import { describe, expect, it } from "vitest";
import { RaiseInputListenerLimit } from "../src/tui/terminal/input-limit.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

function OneInput() {
  useInput(() => {});
  return null;
}

/** 11 个 useInput 会超过 Node 默认 10；仍是合法覆盖层组合，不应刷警告 */
function ElevenInputs() {
  return (
    <>
      {Array.from({ length: 11 }, (_, index) => (
        <OneInput key={index} />
      ))}
    </>
  );
}

function Probe(props: { onValue: (limit: number) => void }) {
  const stdin = useStdin() as unknown as {
    internal_eventEmitter?: { getMaxListeners: () => number };
  };
  props.onValue(stdin.internal_eventEmitter?.getMaxListeners() ?? -1);
  return null;
}

describe("Ink input listener 上限（启动警告修复）", () => {
  it("把内部 input emitter 上限抬到 50，11 个 useInput 不再触发警告", async () => {
    const stdin = new FakeTtyStdin();
    const stdout = Object.assign(new EventEmitter(), {
      columns: 80,
      rows: 24,
      isTTY: true,
      write: () => true,
    });
    let limit = -1;
    const instance = renderInk(
      <>
        <RaiseInputListenerLimit />
        <ElevenInputs />
        <Probe
          onValue={(value) => {
            limit = value;
          }}
        />
      </>,
      {
        stdin: stdin as unknown as typeof process.stdin,
        stdout: stdout as unknown as typeof process.stdout,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(limit).toBe(50);
    instance.unmount();
    stdin.destroy();
  });
});
