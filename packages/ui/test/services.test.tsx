import ReactTestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { ServicesProvider, useServices, type ServiceSet } from "../src/services/context.js";

interface DemoServices extends ServiceSet {
  greet(): string;
}

function Consumer(props: { out: (s: string) => void }) {
  const services = useServices<DemoServices>();
  props.out(services.greet());
  return null;
}

describe("ServicesProvider / useServices（N2-3 注入层）", () => {
  it("组件经 useServices 取到宿主注入的服务集", () => {
    const seen: string[] = [];
    ReactTestRenderer.act(() => {
      ReactTestRenderer.create(
        <ServicesProvider services={{ greet: () => "hello-queue" }}>
          <Consumer out={(s) => seen.push(s)} />
        </ServicesProvider>,
      );
    });
    expect(seen).toEqual(["hello-queue"]);
  });

  it("Provider 外使用 useServices 抛装配错误（fail-fast，静默空值更难排查）", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        ReactTestRenderer.act(() => {
          ReactTestRenderer.create(<Consumer out={() => {}} />);
        }),
      ).toThrow(/ServicesProvider/);
    } finally {
      errSpy.mockRestore();
    }
  });
});
