import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { KeychainEntry } from "@kcode/contracts";
import type { KeychainStore } from "./keychain.js";

/**
 * Windows DPAPI keychain（B5）：CurrentUser 作用域的 ProtectedData 加密，
 * 无口令、无环境变量——密钥绑定当前 Windows 账户（换机/换账户不可解，属预期）。
 * PowerShell 子进程执行 Protect/Unprotect（无原生依赖）；每条目独立加密，
 * list() 只读 ref 不触发解密。
 * 仅 Windows 可用；非 Windows 工厂回退口令方案。
 */
export class DpapiKeychain implements KeychainStore {
  #cache: Map<string, { blob: string; entry?: KeychainEntry }> | null = null;

  constructor(private readonly filePath: string) {}

  static get available(): boolean {
    return process.platform === "win32";
  }

  async get(ref: string): Promise<KeychainEntry | null> {
    const row = (await this.#load()).get(ref);
    if (row === undefined) {
      return null;
    }
    if (row.entry === undefined) {
      row.entry = JSON.parse(await dpapiUnprotect(row.blob)) as KeychainEntry;
    }
    return row.entry;
  }

  async set(ref: string, key: string, audiences: string[]): Promise<void> {
    const map = await this.#load();
    const entry: KeychainEntry = { ref, key, audiences };
    map.set(ref, { blob: await dpapiProtect(JSON.stringify(entry)), entry });
    await this.#flush(map);
  }

  async delete(ref: string): Promise<void> {
    const map = await this.#load();
    map.delete(ref);
    await this.#flush(map);
  }

  async list(): Promise<string[]> {
    return [...(await this.#load()).keys()];
  }

  async #load(): Promise<Map<string, { blob: string; entry?: KeychainEntry }>> {
    if (this.#cache !== null) return this.#cache;
    const map = new Map<string, { blob: string; entry?: KeychainEntry }>();
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as { entries?: Record<string, { blob?: string }> };
      for (const [ref, row] of Object.entries(raw.entries ?? {})) {
        if (typeof row?.blob === "string" && row.blob !== "") {
          map.set(ref, { blob: row.blob });
        }
      }
    } catch {
      // 文件不存在/损坏按空处理（损坏时不覆写，直到下一次成功写入）
    }
    this.#cache = map;
    return map;
  }

  async #flush(map: Map<string, { blob: string; entry?: KeychainEntry }>): Promise<void> {
    const entries: Record<string, { blob: string }> = {};
    for (const [ref, row] of map) {
      entries[ref] = { blob: row.blob };
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify({ v: 1, entries }, null, 2)}\n`, "utf8");
    this.#cache = map;
  }
}

const PS_PROTECT =
  "Add-Type -AssemblyName System.Security; " +
  "$in=[Console]::In.ReadToEnd(); " +
  "$blob=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'); " +
  "[Console]::Out.Write([Convert]::ToBase64String($blob))";
const PS_UNPROTECT =
  "Add-Type -AssemblyName System.Security; " +
  "$in=[Console]::In.ReadToEnd(); " +
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser'); " +
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))";

function runPowerShell(script: string, stdinText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("DPAPI 调用超时"));
    }, 10_000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out !== "") {
        resolve(out.trim());
      } else {
        reject(new Error(`DPAPI 调用失败（exit ${code}）${err.trim() !== "" ? `：${err.trim().slice(0, 200)}` : ""}`));
      }
    });
    child.stdin.end(stdinText, "utf8");
  });
}

function dpapiProtect(plain: string): Promise<string> {
  return runPowerShell(PS_PROTECT, plain);
}

function dpapiUnprotect(blob: string): Promise<string> {
  return runPowerShell(PS_UNPROTECT, blob);
}
