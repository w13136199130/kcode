/**
 * 服务注入层（N2-3，对标 ZCode useServices/IServiceAccessor 的单进程简化）：
 * 组件只经 useServices() 取服务，不直接 import runtime/core/session——Ink 与 DOM 两端同构。
 * 宿主（CLI App 根 / N3 Web 入口）构造 services 对象并经 ServicesProvider 注入；
 * N3 进程边界出现时，services 换成协议代理的同形对象，组件调用点不变。
 */
import { createContext, createElement, useContext, type ReactNode } from "react";

/** 服务集形状：宿主自定义（键到服务实例）；跨端共享的语义层放 state/ 的 store */
export type ServiceSet = Record<string, unknown>;

const ServicesContext = createContext<ServiceSet | null>(null);

export function ServicesProvider<TServices extends ServiceSet>(props: {
  services: TServices;
  children: ReactNode;
}) {
  return createElement(ServicesContext.Provider, { value: props.services }, props.children);
}

/** 组件内取服务：泛型由宿主声明的 services 形状决定（两端组件共享同一调用点） */
export function useServices<TServices extends ServiceSet>(): TServices {
  const services = useContext(ServicesContext);
  if (services === null) {
    throw new Error("useServices 必须在 ServicesProvider 内使用——宿主装配遗漏（N2-3 注入模式）");
  }
  return services as TServices;
}
