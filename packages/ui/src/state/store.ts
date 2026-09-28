import { create, type StoreApi, type UseBoundStore } from "zustand";
import { createRunStatusSlice, type RunStatusSlice } from "./run-status.js";
import { createTranscriptSlice, type TranscriptSlice } from "./transcript.js";

/**
 * UI 语义 store（N2-3，对标 ZCode「单例 store + slice 拆分」改为工厂——每宿主/每会话一份，
 * 避免测试与多会话串态）。slice 间正交；跨 slice 组合动作在宿主层用两个 slice 的动作拼装。
 */
export interface UiState extends RunStatusSlice, TranscriptSlice {}

export type UiStore = UseBoundStore<StoreApi<UiState>>;

export function createUiStore(): UiStore {
  return create<UiState>()((set, get, api) => ({
    ...createRunStatusSlice(set, get, api),
    ...createTranscriptSlice(set, get, api),
  }));
}
