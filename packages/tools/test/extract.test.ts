import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractTool, parsePageRange } from "../src/tools/extract.js";
import { readTool } from "../src/tools/read.js";

let root: string;
const ctx = (): { sessionId: string; cwd: string } => ({ sessionId: "s", cwd: root });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-extract-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parsePageRange", () => {
  it("区间+散点解析、越界过滤、乱序容错", () => {
    expect(parsePageRange("1-3,5", 10)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange("8,2-2", 10)).toEqual([2, 8]);
    expect(parsePageRange("99", 10)).toEqual([]);
    expect(parsePageRange("5-1", 10)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("extract 工具（四格式）", () => {
  it("PDF：pdf-lib 生成 → 按页提取文本", async () => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const text of ["kcode-pdf-page-one", "kcode-pdf-page-two"]) {
      const page = doc.addPage([400, 300]);
      page.drawText(text, { x: 50, y: 200, size: 16, font });
    }
    const path = join(root, "sample.pdf");
    await writeFile(path, await doc.save());

    const all = await extractTool.execute({ path }, ctx());
    expect(all.ok).toBe(true);
    expect(all.output).toContain("共 2 页");
    expect(all.output).toContain("第 1 页");
    expect(all.output).toContain("kcode-pdf-page-one");
    expect(all.output).toContain("kcode-pdf-page-two");

    const picked = await extractTool.execute({ path, pages: "2" }, ctx());
    expect(picked.ok).toBe(true);
    expect(picked.output).toContain("kcode-pdf-page-two");
    expect(picked.output).not.toContain("kcode-pdf-page-one");
  });

  it("DOCX：docx 包生成 → mammoth 提取正文", async () => {
    const { Document, Packer, Paragraph, TextRun } = await import("docx");
    const doc = new Document({
      sections: [{ children: [new Paragraph({ children: [new TextRun("kcode-docx-正文内容")] })] }],
    });
    const path = join(root, "sample.docx");
    await writeFile(path, await Packer.toBuffer(doc));

    const r = await extractTool.execute({ path }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("kcode-docx-正文内容");
  });

  it("XLSX：exceljs 生成 → 表格 TSV 输出、选表与限行", async () => {
    const mod = (await import("exceljs")) as unknown as {
      default?: { Workbook: new () => import("exceljs").Workbook };
    } & { Workbook: new () => import("exceljs").Workbook };
    const ExcelJS = mod.default ?? mod;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("数据表");
    ws.addRow(["工程名", "桥墩直径"]);
    ws.addRow(["六横互通", "1.8"]);
    ws.addRow(["人非桥", "1.1"]);
    wb.addWorksheet("空说明");
    const path = join(root, "sample.xlsx");
    await writeFile(path, new Uint8Array(await wb.xlsx.writeBuffer()));

    const all = await extractTool.execute({ path }, ctx());
    expect(all.ok).toBe(true);
    expect(all.output).toContain("数据表");
    expect(all.output).toContain("六横互通");
    expect(all.output).toContain("桥墩直径");

    const only = await extractTool.execute({ path, sheet: "数据表", maxRows: 1 }, ctx());
    expect(only.ok).toBe(true);
    expect(only.output).toContain("工程名");
    expect(only.output).not.toContain("六横互通");
    expect(only.output).toContain("仅前 1 行");

    const missing = await extractTool.execute({ path, sheet: "不存在" }, ctx());
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("不存在");
  });

  it("图片：元数据 + imagePaths 挂载", async () => {
    // 1×1 PNG（合法最小文件）
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d9940000000049454e44ae426082",
      "hex",
    );
    const path = join(root, "tiny.png");
    await writeFile(path, png);

    const r = await extractTool.execute({ path }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("1×1");
    expect(r.imagePaths).toEqual([path]);
  });

  it("read 对文档类型重定向到 extract", async () => {
    const r = await readTool.execute({ path: "a/b.pdf" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("extract");
  });

  it("不支持的类型明确报错", async () => {
    const r = await extractTool.execute({ path: "x.txt" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不支持的类型");
  });
});
