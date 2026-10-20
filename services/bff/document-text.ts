// Document text extraction for email attachments.
//
// Format-aware, not domain-aware: this turns a document's bytes into readable
// text with page/slide boundaries, and knows nothing about companies, Notion
// fields, or any workflow. Callers decide what the text means.
//
// Pure JavaScript (unpdf for PDF, fflate for OOXML zips): no LibreOffice, no
// renderer, no OCR. A document whose text cannot be produced is reported
// honestly (`unreadable`) rather than passed on as empty content. A document
// with no usable text at all (a scanned PDF, an image-only or empty
// DOCX/PPTX) yields `noText` so the caller can fall back to vision or ask
// the sender, instead of treating the extraction as a success.
//
// Safety here is operational, not editorial: the caps below bound resources
// (archive entry count, per-part and total decompressed bytes) against a
// malicious or malformed archive; there is deliberately no cap on how much
// real document text is returned.
import { extractText } from "unpdf";
import { Unzip, UnzipInflate } from "fflate";

export interface ExtractedDocument {
  /** Extracted text, with page/slide/sheet boundaries. Empty when nothing
   * could be read. */
  text: string;
  /** True when the format is known but its text cannot be extracted (legacy
   * binary Office, ODF, or an archive that could not be parsed). */
  unreadable?: boolean;
  /** True when extraction ran but the document carries no usable text at all
   * (a scanned/image-only PDF, or an image-only/empty DOCX/PPTX). The caller
   * can look at the image instead. */
  noText?: boolean;
  /** Non-fatal notes, e.g. an archive part that was skipped. */
  warnings: string[];
}

/** Bounds on archive processing: enough for any real Office document, small
 * enough that a crafted zip cannot exhaust memory. */
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_PART_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Formats handled as plain UTF-8 text rather than a structured container. */
const TEXT_KINDS = new Set(["text", "csv", "tsv", "json", "markdown", "rtf"]);

/** Formats whose text we cannot extract (legacy binary Office and ODF).
 * They are still accepted and stored; only reading is unsupported. */
const UNREADABLE_KINDS = new Set(["doc", "ppt", "xls", "odt", "ods", "odp"]);

function decodeCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "�";
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => decodeCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => decodeCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** Drop control characters that should never reach a model, keeping the
 * whitespace a document legitimately uses. */
function cleanText(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) out += value[index];
    else if (code >= 0x20) out += value[index];
  }
  return out;
}

/** Pull the text runs of one OOXML part. `<w:t>`/`<a:t>` carry the text; the
 * paragraph and break tags become newlines and spaces so line structure is
 * preserved without an XML parser (and without entity expansion). */
function ooxmlPartText(xml: string, runTag: "w:t" | "a:t"): string {
  const paragraphs = xml.split(runTag === "w:t" ? /<\/w:p>/ : /<\/a:p>/);
  const lines = paragraphs.map((paragraph) => {
    const withBreaks = paragraph
      .replace(/<\/?(?:w:br|w:cr|a:br)(?:\s[^>]*)?\/?>/g, `<${runTag}>\n</${runTag}>`)
      .replace(/<\/?(?:w:tab|a:tab)(?:\s[^>]*)?\/?>/g, `<${runTag}> </${runTag}>`);
    const runs = withBreaks.match(new RegExp(`<${runTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${runTag}>`, "g")) ?? [];
    return runs
      .map((run) => decodeXmlEntities(run.replace(new RegExp(`</?${runTag}(?:\\s[^>]*)?>`, "g"), "")))
      .join("");
  });
  return cleanText(lines.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
}

interface ArchiveRead {
  files: Record<string, Uint8Array>;
  warnings: string[];
}

/** Inflate only the requested entries, bounding entry count and decompressed
 * bytes by the actual inflated output so a zip bomb cannot exhaust memory. */
function readArchiveParts(bytes: Buffer, wanted: (name: string) => boolean): ArchiveRead {
  const warnings: string[] = [];
  const files: Record<string, Uint8Array> = {};
  let entries = 0;
  let total = 0;
  let overLimit = false;
  let fileError: unknown;
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) {
      overLimit = true;
      return;
    }
    if (overLimit || fileError || !wanted(file.name)) return;
    let size = 0;
    let skipped = false;
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) {
        fileError = err;
        return;
      }
      if (skipped || overLimit || fileError) return;
      if (size + chunk.length > MAX_PART_BYTES) {
        total -= size;
        chunks.length = 0;
        size = 0;
        skipped = true;
        warnings.push(`skipped oversized part: ${file.name}`);
        return;
      }
      if (total + chunk.length > MAX_TOTAL_BYTES) {
        total -= size;
        chunks.length = 0;
        size = 0;
        skipped = true;
        overLimit = true;
        return;
      }
      if (chunk.length > 0) {
        chunks.push(chunk.slice());
        size += chunk.length;
        total += chunk.length;
      }
      if (final && !skipped) {
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          out.set(part, offset);
          offset += part.length;
        }
        files[file.name] = out;
      }
    };
    try {
      file.start();
    } catch (error) {
      fileError = error;
    }
  };
  const input = new Uint8Array(bytes);
  for (let offset = 0; offset < input.length; offset += 64 * 1024) {
    const end = Math.min(offset + 64 * 1024, input.length);
    unzipper.push(input.subarray(offset, end), end === input.length);
    if (fileError) break;
  }
  if (fileError) throw fileError;
  if (overLimit) warnings.push("archive exceeds the processing limit");
  return { files, warnings };
}

async function extractPdf(bytes: Buffer): Promise<ExtractedDocument> {
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: false });
  const pages = text.map((page) => cleanText(page).trim());
  const body = pages.map((page, index) => `--- page ${index + 1} ---\n${page}`).join("\n\n").trim();
  const noText = body.replace(/--- page \d+ ---/g, "").trim().length === 0;
  return {
    text: body,
    ...(noText ? { noText: true } : {}),
    warnings: noText ? ["no extractable text (image)"] : [],
  };
}

function extractDocx(bytes: Buffer): ExtractedDocument {
  const { files, warnings } = readArchiveParts(bytes, (name) => name === "word/document.xml");
  const document = files["word/document.xml"];
  if (!document) {
    return { text: "", unreadable: true, warnings: [...warnings, "the document body was not found in the archive"] };
  }
  const text = ooxmlPartText(Buffer.from(document).toString("utf8"), "w:t");
  if (text.trim().length === 0) {
    return { text, noText: true, warnings: [...warnings, "no extractable text (image)"] };
  }
  return { text, warnings };
}

function extractPptx(bytes: Buffer): ExtractedDocument {
  const slideName = /^ppt\/slides\/slide(\d+)\.xml$/;
  const { files, warnings } = readArchiveParts(bytes, (name) => slideName.test(name));
  const slides = Object.keys(files)
    .map((name) => ({ name, number: Number(slideName.exec(name)![1]) }))
    .sort((a, b) => a.number - b.number);
  if (slides.length === 0) {
    return { text: "", unreadable: true, warnings: [...warnings, "no slides were found in the presentation"] };
  }
  const body = slides
    .map(({ name, number }) => `--- slide ${number} ---\n${ooxmlPartText(Buffer.from(files[name]!).toString("utf8"), "a:t")}`)
    .join("\n\n")
    .trim();
  if (body.replace(/--- slide \d+ ---/g, "").trim().length === 0) {
    return { text: body, noText: true, warnings: [...warnings, "no extractable text (image)"] };
  }
  return { text: body, warnings };
}

/** A worksheet part inside an xlsx workbook: `xl/worksheets/sheetN.xml`. */
const XLSX_SHEET_FILE = /^xl\/worksheets\/sheet(\d+)\.xml$/;

/** One `<sheet name="…">` entry of `xl/workbook.xml`, in document order. */
const XLSX_SHEET_ENTRY = /<sheet\b[^>]*\bname=(?:"([^"]*)"|'([^']*)')/g;

/** Row, cell, value, inline-string, and text-run tags of one worksheet,
 * in a single pass: `<v>` and `<t>` carry no nested tags (cell text is
 * entity-escaped), so the text runs straight to the next `<`. */
const XLSX_SHEET_TOKEN = /<(\/?)(row|c|v|is|t)\b([^>]*)>([^<]*)/g;

/** Sparse-column guard: a row that jumps thousands of columns (for example
 * a lone value at XFD) pads with empty fields up to this many, so a stray
 * cell cannot bloat the text with kilobytes of tabs. Real content is never
 * capped; trailing empties are never emitted. */
const XLSX_MAX_CELL_GAP = 100;

/** Zero-based column index of an `A1`-style cell reference; -1 when the
 * reference is missing or malformed, in which case the cell follows the
 * previous one. */
function xlsxColumnIndex(reference: string | undefined): number {
  if (!reference) return -1;
  let column = 0;
  let index = 0;
  while (index < reference.length) {
    const code = reference.charCodeAt(index);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
    index += 1;
  }
  if (index === 0) return -1;
  return column - 1;
}

/** True when text holds control characters that must never reach a model.
 * The same set `cleanText` drops, checked first so clean output skips a
 * second pass. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/** One decoded cell value: entities resolved, control characters dropped,
 * in-cell line breaks flattened so TSV rows stay intact. */
function finalizeXlsxCell(value: string): string {
  const decoded = value.includes("&") ? decodeXmlEntities(value) : value;
  const cleaned = hasControlCharacters(decoded) ? cleanText(decoded) : decoded;
  return cleaned.replace(/\r\n|\r|\n/g, " ");
}

/** Shared strings are decoded on first use and memoized: the table is
 * usually the largest part of the workbook, and empty or numeric-only
 * sheets must not pay for decoding it. */
interface XlsxSharedStrings {
  raw: string[];
  cache: (string | undefined)[];
}

function parseXlsxSharedStrings(xml: string): XlsxSharedStrings {
  if (!xml) return { raw: [], cache: [] };
  const raw = xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? [];
  return { raw, cache: raw.map(() => undefined) };
}

function xlsxSharedString(table: XlsxSharedStrings, indexText: string): string {
  const index = Number(indexText.trim());
  if (!Number.isInteger(index) || index < 0 || index >= table.raw.length) return "";
  const cached = table.cache[index];
  if (cached !== undefined) return cached;
  const runs = table.raw[index]!.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [];
  const decoded = finalizeXlsxCell(runs.map((run) => run.replace(/<\/?t\b[^>]*>/g, "")).join(""));
  table.cache[index] = decoded;
  return decoded;
}

/** Sheet names from `xl/workbook.xml`, in order. Positional: the first name
 * belongs to the lowest-numbered sheet file. */
function xlsxSheetNames(xml: string): string[] {
  const names: string[] = [];
  XLSX_SHEET_ENTRY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = XLSX_SHEET_ENTRY.exec(xml)) !== null) {
    const raw = match[1] ?? match[2] ?? "";
    names.push(raw.includes("&") ? decodeXmlEntities(raw) : raw);
  }
  return names;
}

/** One worksheet as TSV: cells joined with tabs, rows with newlines, empty
 * rows skipped, sparse columns padded with empty fields. Formulas contribute
 * their cached `<v>` result; error cells contribute nothing. */
function parseXlsxSheet(xml: string, shared: XlsxSharedStrings): string {
  const rows: string[] = [];
  let cells: string[] = [];
  let prevColumn = -1;
  let inRow = false;
  let cellOpen = false;
  let cellAttrs = "";
  let cellValue = "";
  let inlineBuffer = "";
  let inInlineString = false;

  const pushCell = (): void => {
    const reference = /\br="([^"]*)"/.exec(cellAttrs)?.[1];
    const column = xlsxColumnIndex(reference);
    if (column > prevColumn) {
      const gap = Math.min(column - prevColumn - 1, XLSX_MAX_CELL_GAP);
      for (let index = 0; index < gap; index += 1) cells.push("");
      prevColumn = column;
    }
    const type = /\bt="([a-zA-Z]+)"/.exec(cellAttrs)?.[1] ?? "n";
    let raw: string;
    if (type === "s") raw = xlsxSharedString(shared, cellValue);
    else if (type === "inlineStr") raw = inlineBuffer;
    else if (type === "b") raw = cellValue.trim() === "1" ? "TRUE" : cellValue.trim() === "0" ? "FALSE" : cellValue.trim();
    else if (type === "e") raw = "";
    else raw = cellValue.trim();
    cells.push(finalizeXlsxCell(raw));
  };

  const closeRow = (): void => {
    if (!inRow) return;
    inRow = false;
    const line = cells.join("\t").replace(/\t+$/, "");
    cells = [];
    prevColumn = -1;
    if (line.trim().length > 0) rows.push(line);
  };

  XLSX_SHEET_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = XLSX_SHEET_TOKEN.exec(xml)) !== null) {
    const closing = match[1] === "/";
    const tag = match[2];
    const attrs = match[3] ?? "";
    const text = match[4] ?? "";
    if (!closing && tag === "row") {
      closeRow();
      inRow = true;
    } else if (closing && tag === "row") {
      closeRow();
    } else if (!closing && tag === "c") {
      if (!inRow) inRow = true;
      cellAttrs = attrs;
      cellValue = "";
      inlineBuffer = "";
      inInlineString = false;
      cellOpen = true;
      // A self-closed `<c r="B2"/>` is an explicitly empty cell: it holds
      // its column for gap purposes but contributes no value.
      if (attrs.trimEnd().endsWith("/")) {
        pushCell();
        cellOpen = false;
      }
    } else if (closing && tag === "c") {
      if (cellOpen) {
        pushCell();
        cellOpen = false;
      }
    } else if (!closing && tag === "v") {
      if (cellOpen && !inInlineString) cellValue += text;
    } else if (!closing && tag === "is") {
      inInlineString = true;
      inlineBuffer = "";
    } else if (closing && tag === "is") {
      inInlineString = false;
    } else if (!closing && tag === "t") {
      if (cellOpen && inInlineString) inlineBuffer += text;
    }
  }
  closeRow();
  return rows.join("\n");
}

function extractXlsx(bytes: Buffer): ExtractedDocument {
  const { files, warnings } = readArchiveParts(
    bytes,
    (name) => name === "xl/sharedStrings.xml" || name === "xl/workbook.xml" || XLSX_SHEET_FILE.test(name),
  );
  const sheets = Object.keys(files)
    .filter((name) => XLSX_SHEET_FILE.test(name))
    .map((name) => ({ name, number: Number(XLSX_SHEET_FILE.exec(name)![1]) }))
    .sort((a, b) => a.number - b.number);
  if (sheets.length === 0) {
    return { text: "", unreadable: true, warnings: [...warnings, "no sheets were found in the workbook"] };
  }
  const sharedXml = files["xl/sharedStrings.xml"];
  const shared = parseXlsxSharedStrings(sharedXml ? Buffer.from(sharedXml).toString("utf8") : "");
  const workbookXml = files["xl/workbook.xml"];
  const names = workbookXml ? xlsxSheetNames(Buffer.from(workbookXml).toString("utf8")) : [];
  const body = sheets
    .map(({ name, number }, index) => {
      const sheetName = names[index];
      const header = sheetName ? `--- sheet ${number}: ${sheetName} ---` : `--- sheet ${number} ---`;
      return `${header}\n${parseXlsxSheet(Buffer.from(files[name]!).toString("utf8"), shared)}`;
    })
    .join("\n\n")
    .trim();
  if (body.replace(/--- sheet \d+(?:: [^\n]*)? ---/g, "").trim().length === 0) {
    return { text: body, noText: true, warnings: [...warnings, "no extractable text (empty)"] };
  }
  return { text: body, warnings };
}

/**
 * Extract readable text from a supported document. Resolves a structured
 * result for every input: never throws on malformed content (reported as
 * `unreadable` or empty text with a warning).
 */
export async function extractDocumentText(kind: string, bytes: Buffer): Promise<ExtractedDocument> {
  try {
    if (kind === "pdf") return await extractPdf(bytes);
    if (kind === "docx") return extractDocx(bytes);
    if (kind === "pptx") return extractPptx(bytes);
    if (kind === "xlsx") return extractXlsx(bytes);
    if (TEXT_KINDS.has(kind)) return { text: cleanText(bytes.toString("utf8")).trim(), warnings: [] };
    if (UNREADABLE_KINDS.has(kind)) {
      return { text: "", unreadable: true, warnings: [`${kind} text cannot be extracted; the file can still be stored`] };
    }
    return { text: "", unreadable: true, warnings: [`no reader for ${kind}`] };
  } catch (error) {
    return {
      text: "",
      unreadable: true,
      warnings: [`the ${kind} file could not be read: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`],
    };
  }
}
