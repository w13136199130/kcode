import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";
import { imageSize } from "image-size";
import { resolveInCtx, displayPath } from "./paths.js";

const ExtractArgs = z.object({
  path: z.string().min(1),
  /** PDF 页码选择："1-5,8"（缺省全部） */
  pages: z.string().optional(),
  /** XLSX 工作表名（缺省全部） */
  sheet: z.string().optional(),
  /** XLSX 每表最多返回行数（默认 200） */
  maxRows: z.number().int().positive().optional(),
});

/** 输出字符上限（与 bash 工具一致量级，防超大文档撑爆上下文） */
const MAX_OUTPUT_CHARS = 60_000;
const MAX_IMAGES = 3;

const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"] as const;

/**
 * 文档/图片提取工具：PDF（pdfjs-dist 文本层）、DOCX（mammoth）、XLSX（exceljs 表格转 TSV）、
 * 图片（尺寸元数据 + 挂载给视觉模型）。全纯 JS，无本地二进制依赖。
 */
export const extractTool: Tool = {
  definition: {
    name: "extract",
    description:
      "提取文档内容为文本：PDF（按页文本，pages 选页如 \"1-5,8\"）、DOCX（正文文本）、" +
      "XLSX（各工作表转表格，sheet 选表、maxRows 限行）、图片（返回尺寸；支持视觉的模型可直接查看挂载图）。" +
      "只读操作；二进制文档不要用 read，用本工具。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文档路径（相对会话 cwd 或绝对）" },
        pages: { type: "string", description: "PDF 页码选择，如 \"1-5,8\"（缺省全部）" },
        sheet: { type: "string", description: "XLSX 工作表名（缺省全部）" },
        maxRows: { type: "integer", description: "XLSX 每表最多行数（默认 200）" },
      },
      required: ["path"],
    },
    readOnly: true,
  },
  async execute(input, ctx: ToolContext): Promise<ToolOutput> {
    const parsed = ExtractArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    const { path, pages, sheet, maxRows } = parsed.data;
    const abs = resolveInCtx(path, ctx);
    const ext = extname(abs).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext as (typeof SUPPORTED_EXTENSIONS)[number])) {
      return {
        ok: false,
        output: "",
        error: `不支持的类型 ${ext || "（无扩展名）"}：支持 ${SUPPORTED_EXTENSIONS.join(" / ")}`,
      };
    }
    let data: Buffer;
    try {
      data = await readFile(abs);
    } catch (err) {
      return { ok: false, output: "", error: `读取失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    const label = displayPath(abs, ctx);
    try {
      if (ext === ".pdf") {
        return await extractPdf(data, pages, label);
      }
      if (ext === ".docx") {
        return extractDocx(data, label);
      }
      if (ext === ".xlsx") {
        return await extractXlsx(data, sheet, maxRows ?? 200, label);
      }
      return extractImage(data, abs, label);
    } catch (err) {
      return { ok: false, output: "", error: `提取失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

/** 解析 "1-5,8" 页码选择 → 升序页码集合（1 起） */
export function parsePageRange(spec: string, totalPages: number): number[] {
  const wanted = new Set<number>();
  for (const part of spec.split(",")) {
    const seg = part.trim();
    if (seg === "") continue;
    const dash = seg.indexOf("-");
    if (dash === -1) {
      const n = Number.parseInt(seg, 10);
      if (Number.isInteger(n)) wanted.add(n);
    } else {
      const from = Number.parseInt(seg.slice(0, dash), 10);
      const to = Number.parseInt(seg.slice(dash + 1), 10);
      if (Number.isInteger(from) && Number.isInteger(to)) {
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) wanted.add(i);
      }
    }
  }
  return [...wanted].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
}

/** pdfjs-dist 的最小本地接口（legacy 子路径无类型声明，exports 也限制了子路径解析） */
interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
type PdfjsModule = {
  getDocument: (opts: { data: Uint8Array }) => { promise: Promise<PdfDocument> };
};

/** exceljs 的最小本地接口（仅用到读表路径） */
interface XlsxCell {
  value: unknown;
}
interface XlsxRow {
  eachCell(opts: { includeEmpty: boolean }, cb: (cell: XlsxCell, n: number) => void): void;
}
interface XlsxWorksheet {
  name: string;
  rowCount: number;
  eachRow(opts: { includeEmpty: boolean }, cb: (row: XlsxRow, n: number) => void): void;
}
interface XlsxWorkbook {
  worksheets: XlsxWorksheet[];
  xlsx: {
    load(data: unknown): Promise<void>;
  };
}

async function extractPdf(data: Buffer, pages: string | undefined, label: string): Promise<ToolOutput> {
  // legacy CJS 构建（v3 无 .mjs；文本提取无需 canvas）——用户环境已验证此路径
  const imported = (await import("pdfjs-dist/legacy/build/pdf.js")) as unknown as {
    default?: PdfjsModule;
  } & PdfjsModule;
  const pdfjs = imported.default ?? imported;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const total = doc.numPages;
  const wanted =
    pages !== undefined && pages !== "" ? parsePageRange(pages, total) : Array.from({ length: total }, (_, i) => i + 1);
  if (wanted.length === 0) {
    return { ok: false, output: "", error: `页码选择 ${pages} 不在 1-${total} 范围内` };
  }
  const parts: string[] = [`${label}（共 ${total} 页，提取 ${wanted.length} 页${pages !== undefined ? `：${pages}` : ""}）`];
  let used = 0;
  for (const pageNo of wanted) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    let pageText = "";
    let lastEndedLine = false;
    for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== "string") continue;
      pageText += item.str;
      if (item.hasEOL === true) {
        pageText += "\n";
        lastEndedLine = true;
      } else {
        lastEndedLine = false;
      }
    }
    void lastEndedLine;
    parts.push(`===== 第 ${pageNo} 页 =====\n${pageText.trim()}`);
    used += pageText.length;
    if (used > MAX_OUTPUT_CHARS) {
      parts.push(`…（已超过 ${MAX_OUTPUT_CHARS} 字符上限，未提取的页：${wanted.slice(wanted.indexOf(pageNo) + 1).join(",") || "无"}；可用 pages 参数分段提取）`);
      break;
    }
  }
  await doc.destroy();
  return { ok: true, output: parts.join("\n\n") };
}

/** mammoth 最小本地接口（CJS 包，动态加载） */
type MammothModule = {
  extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
};

async function extractDocx(data: Buffer, label: string): Promise<ToolOutput> {
  const mammoth = (await import("mammoth")) as unknown as MammothModule;
  const result = await mammoth.extractRawText({ buffer: data });
  const text = result.value.trim();
  if (text === "") {
    return { ok: false, output: "", error: `${label} 未提取到文本（可能是纯图片/扫描件 docx）` };
  }
  return { ok: true, output: `${label}（DOCX 正文）\n${cap(text)}` };
}

async function extractXlsx(data: Buffer, sheet: string | undefined, maxRows: number, label: string): Promise<ToolOutput> {
  // exceljs CJS：Workbook 是导出对象的属性
  const imported = (await import("exceljs")) as unknown as {
    default?: { Workbook: new () => XlsxWorkbook };
  } & { Workbook: new () => XlsxWorkbook };
  const ExcelJS = imported.default ?? imported;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as Parameters<XlsxWorkbook["xlsx"]["load"]>[0]);
  const parts: string[] = [`${label}（XLSX，工作表：${wb.worksheets.map((s) => s.name).join("、") || "无"}）`];
  for (const ws of wb.worksheets) {
    if (sheet !== undefined && ws.name !== sheet) continue;
    const rowCount = Math.min(ws.rowCount, maxRows);
    if (rowCount === 0) {
      parts.push(`--- 表 ${ws.name}：空 ---`);
      continue;
    }
    const lines: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n > rowCount) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v: unknown = cell.value;
        const text =
          v === null || v === undefined
            ? ""
            : typeof v === "object" && "richText" in v
              ? (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join("")
              : v instanceof Date
                ? v.toISOString().slice(0, 10)
                : String(v);
        cells.push(text.replace(/[\t\r\n]+/g, " ").slice(0, 200));
      });
      lines.push(cells.join("\t"));
    });
    parts.push(
      `--- 表 ${ws.name}（${rowCount}/${ws.rowCount} 行）---\n${lines.join("\n")}${ws.rowCount > maxRows ? `\n…（仅前 ${maxRows} 行，可用 maxRows 调整）` : ""}`,
    );
  }
  const out = parts.join("\n\n");
  if (sheet !== undefined && !wb.worksheets.some((s) => s.name === sheet)) {
    return { ok: false, output: "", error: `工作表 ${sheet} 不存在；可用：${wb.worksheets.map((s) => s.name).join("、")}` };
  }
  return { ok: true, output: cap(out) };
}

function extractImage(data: Buffer, abs: string, label: string): ToolOutput {
  const size = imageSize(data);
  return {
    ok: true,
    output:
      `${label}（图片 ${size.type ?? ""}，${size.width}×${size.height}）已挂载。\n` +
      "当前模型若支持视觉即可直接查看；若不支持，请用 /model 切换到视觉模型（如 glm-4.5v 系）后重新提取。",
    imagePaths: [abs].slice(0, MAX_IMAGES),
  };
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（截断：输出超过 ${MAX_OUTPUT_CHARS} 字符，可用 pages/sheet/maxRows 分段）`
    : text;
}
