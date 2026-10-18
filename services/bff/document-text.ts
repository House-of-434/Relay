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
  /** Extracted text, page/slide boundaries included. Empty when nothing could
   * be read. */
  text: string;
  /** True when the format is known but its text cannot be extracted (legacy
   * binary Office, or an archive that could not be parsed). */
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

/** Formats whose text we cannot extract in v1 (legacy binary Office and ODF).
 * They are still accepted and stored; only reading is unsupported. */
const UNREADABLE_KINDS = new Set(["doc", "ppt", "xls", "xlsx", "odt", "ods", "odp"]);

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
