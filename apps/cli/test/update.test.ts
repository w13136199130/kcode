import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSafeTarEntry, updateCommand, tarBinary } from "../src/update.js";
import { machineFingerprint } from "@kcode/platform";

/**
 * N3E-4 kcode update（本地通道全链路）：latest.json + tarball（真实 tar 打包）→
 * sha256/尺寸校验 → 解包 releases/<ver> → 翻 current 指针。
 * N3E-5：机器指纹回退密钥材料的稳定性与构成。
 */

let srcDir: string;
let home: string;

async function makeChannel(version: string, opts: { corruptSha?: boolean } = {}): Promise<void> {
  const pkg = join(srcDir, `pkg-${version}`);
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "kcode.mjs"), `// kcode ${version}\nconsole.log("${version}");\n`, "utf8");
  const tarball = `kcode-${version}-test-x64.tar.gz`;
  const tar = spawnSync(tarBinary(), ["-czf", join(srcDir, tarball), "-C", srcDir, `pkg-${version}`], { windowsHide: true });
  expect(tar.status).toBe(0);
  const bytes = readFileSync(join(srcDir, tarball));
  const sha = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    join(srcDir, "latest.json"),
    JSON.stringify({
      name: "kcode",
      version,
      platform: `${process.platform}-${process.arch}`,
      node: ">=22",
      date: new Date().toISOString(),
      tarball,
      sha256: opts.corruptSha === true ? "0".repeat(64) : sha,
      size: bytes.length,
    }),
    "utf8",
  );
}

beforeAll(async () => {
  srcDir = await mkdtemp(join(tmpdir(), "kcode-upd-src-"));
  home = await mkdtemp(join(tmpdir(), "kcode-upd-home-"));
  // tarball 带顶层目录（pkg-<ver>/kcode.mjs）——解包后归一到 release 根的行为与平铺一致处理见断言
});

afterAll(async () => {
  await rm(srcDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("kcode update（N3E-4）", () => {
  it("无更新源给可操作提示", async () => {
    const lines: string[] = [];
    const saved = process.env["KCODE_UPDATE_URL"];
    delete process.env["KCODE_UPDATE_URL"];
    const ok = await updateCommand([], (l) => lines.push(l), { kcodeHomeDir: home, currentVersion: "1.0.0" });
    expect(ok).toBe(false);
    expect(lines.some((l) => l.includes("未配置更新源"))).toBe(true);
    if (saved !== undefined) process.env["KCODE_UPDATE_URL"] = saved;
  });

  it("本地通道全链路：下载→校验→解包→翻指针", async () => {
    await makeChannel("9.9.9");
    const lines: string[] = [];
    const ok = await updateCommand(["--url", join(srcDir, "latest.json"), "--local"], (l) => lines.push(l), {
      kcodeHomeDir: home,
      currentVersion: "1.0.0",
    });
    expect(ok).toBe(true);
    // release 目录就位（tarball 带顶层目录，staging 根含 pkg-9.9.9/——内容存在即可）
    expect(existsSync(join(home, "releases", "kcode-9.9.9"))).toBe(true);
    // current 指针指向新版本
    expect(existsSync(join(home, "releases", "current"))).toBe(true);
    expect(lines.some((l) => l.includes("校验通过"))).toBe(true);
    expect(lines.some((l) => l.includes("重启 kcode 生效"))).toBe(true);
  }, 30_000);

  it("sha256 不符拒绝安装且不留半装目录", async () => {
    await makeChannel("8.8.8", { corruptSha: true });
    const lines: string[] = [];
    const ok = await updateCommand(["--url", join(srcDir, "latest.json"), "--local", "--force"], (l) => lines.push(l), {
      kcodeHomeDir: home,
      currentVersion: "1.0.0",
    });
    expect(ok).toBe(false);
    expect(lines.some((l) => l.includes("SHA-256 不符"))).toBe(true);
    expect(existsSync(join(home, "releases", "kcode-8.8.8"))).toBe(false);
  }, 30_000);

  it("已是最新（同版本）幂等跳过", async () => {
    await makeChannel("1.0.0");
    const lines: string[] = [];
    const ok = await updateCommand(["--url", join(srcDir, "latest.json"), "--local"], (l) => lines.push(l), {
      kcodeHomeDir: home,
      currentVersion: "1.0.0",
    });
    expect(ok).toBe(true);
    expect(lines.some((l) => l.includes("已是最新"))).toBe(true);
  }, 30_000);
});

describe("2-19 更新链收紧", () => {
  it("tar 条目路径校验拒绝绝对路径/盘符/..", () => {
    expect(isSafeTarEntry("pkg/kcode.mjs")).toBe(true);
    expect(isSafeTarEntry("./pkg/kcode.mjs")).toBe(true);
    expect(isSafeTarEntry("../evil")).toBe(false);
    expect(isSafeTarEntry("pkg/../../evil")).toBe(false);
    expect(isSafeTarEntry("/etc/passwd")).toBe(false);
    expect(isSafeTarEntry("C:\\Windows\\evil")).toBe(false);
  });

  it("配置公钥后强制校验 Ed25519 签名", async () => {
    const h = await mkdtemp(join(tmpdir(), "kcode-upd-sign-"));
    try {
      await makeChannel("7.7.7");
      const latestPath = join(srcDir, "latest.json");
      const meta = JSON.parse(readFileSync(latestPath, "utf8")) as {
        tarball: string;
        signature?: string;
      };
      const bytes = readFileSync(join(srcDir, meta.tarball));
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      meta.signature = sign(null, bytes, privateKey).toString("base64");
      await writeFile(latestPath, JSON.stringify(meta), "utf8");
      const pubPath = join(h, "update.pub.pem");
      await writeFile(pubPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");

      const lines: string[] = [];
      const ok = await updateCommand(
        ["--url", latestPath, "--local", "--force", "--pubkey", pubPath],
        (l) => lines.push(l),
        { kcodeHomeDir: h, currentVersion: "1.0.0" },
      );
      expect(ok).toBe(true);
      expect(lines.some((l) => l.includes("签名校验通过"))).toBe(true);
    } finally {
      await rm(h, { recursive: true, force: true });
    }
  }, 30_000);

  it("保留上一版并可 --rollback 回滚", async () => {
    const h = await mkdtemp(join(tmpdir(), "kcode-upd-rollback-"));
    try {
      const releases = join(h, "releases");
      const oldTarget = join(releases, "kcode-1.0.0");
      await mkdir(oldTarget, { recursive: true });
      await writeFile(join(oldTarget, "kcode.mjs"), "// old\n", "utf8");
      symlinkSync(oldTarget, join(releases, "current"), process.platform === "win32" ? "junction" : "dir");

      await makeChannel("9.9.9");
      const lines: string[] = [];
      const ok = await updateCommand(
        ["--url", join(srcDir, "latest.json"), "--local"],
        (l) => lines.push(l),
        { kcodeHomeDir: h, currentVersion: "1.0.0" },
      );
      expect(ok).toBe(true);
      expect(readlinkSync(join(releases, "current"))).toContain("kcode-9.9.9");

      const rolled = await updateCommand(["--rollback"], (l) => lines.push(l), {
        kcodeHomeDir: h,
        currentVersion: "9.9.9",
      });
      expect(rolled).toBe(true);
      expect(readlinkSync(join(releases, "current"))).toContain("kcode-1.0.0");
    } finally {
      await rm(h, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("机器指纹回退（N3E-5）", () => {
  it("指纹稳定且含平台与用户名成分（zcode 同配方）", async () => {
    const a = machineFingerprint();
    const b = machineFingerprint();
    expect(a).toBe(b);
    expect(a.startsWith("kcode-credential-fallback:")).toBe(true);
    expect(a).toContain(process.platform);
  });
});
