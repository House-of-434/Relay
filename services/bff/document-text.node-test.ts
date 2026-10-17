import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";

import { extractDocumentText } from "./document-text.ts";

/** A minimal, valid one-page PDF whose content stream draws the given lines.
 * Built here so the test exercises the real pdf parser, not a stub. */
function minimalPdf(lines: string[]): Buffer {
  const content = [
    "BT",
    "/F1 24 Tf",
    "72 700 Td",
    ...lines.flatMap((line, index) => (index === 0 ? [`(${line}) Tj`] : ["0 -36 Td", `(${line}) Tj`])),
    "ET",
  ].join("\n");
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function docx(body: string): Buffer {
  return Buffer.from(zipSync({ "word/document.xml": strToU8(body) }));
}

function pptx(slides: Record<number, string>): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const [number, text] of Object.entries(slides)) {
    files[`ppt/slides/slide${number}.xml`] = strToU8(`<p:sp><a:t>${text}</a:t></p>`);
  }
  return Buffer.from(zipSync(files));
}

test("PDF text is extracted with page boundaries", async () => {
  const result = await extractDocumentText("pdf", minimalPdf(["Hello Deck", "Raise 1.5M"]));
  assert.equal(result.unreadable, undefined);
  assert.match(result.text, /--- page 1 ---/);
  assert.match(result.text, /Hello Deck/);
  assert.match(result.text, /Raise 1\.5M/);
});

test("a PDF with no text layer reports noText without failing", async () => {
  const result = await extractDocumentText("pdf", minimalPdf([]));
  assert.equal(result.noText, true);
  assert.deepEqual(result.warnings, ["no extractable text (image)"]);
});

test("DOCX text is read from word/document.xml, paragraphs preserved", async () => {
  const body = "<w:document><w:body>"
    + "<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space=\"preserve\"> Deck</w:t></w:r></w:p>"
    + "<w:p><w:r><w:t>Second line</w:t></w:r></w:p>"
    + "</w:body></w:document>";
  const result = await extractDocumentText("docx", docx(body));
  assert.equal(result.unreadable, undefined);
  assert.match(result.text, /Hello Deck\nSecond line/);
});

test("PPTX slides are extracted in numeric order, not archive order", async () => {
  const result = await extractDocumentText("pptx", pptx({ 2: "Second slide", 10: "Tenth slide", 1: "First slide" }));
  assert.equal(result.unreadable, undefined);
  const first = result.text.indexOf("--- slide 1 ---");
  const second = result.text.indexOf("--- slide 2 ---");
  const tenth = result.text.indexOf("--- slide 10 ---");
  assert.ok(first >= 0 && second > first && tenth > second, result.text);
  assert.match(result.text, /First slide/);
  assert.match(result.text, /Tenth slide/);
});

test("plain text kinds are returned as UTF-8 text", async () => {
  const result = await extractDocumentText("csv", Buffer.from("company,raise\nNakato,1.5M\n"));
  assert.equal(result.text, "company,raise\nNakato,1.5M");
});

test("legacy binary Office reports unreadable rather than empty success", async () => {
  for (const kind of ["ppt", "doc", "xls", "odt"]) {
    const result = await extractDocumentText(kind, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    assert.equal(result.unreadable, true, kind);
    assert.equal(result.text, "", kind);
  }
});

test("a malformed archive is reported unreadable, never thrown", async () => {
  const result = await extractDocumentText("docx", Buffer.from("PK\x03\x04 not really a zip"));
  assert.equal(result.unreadable, true);
  assert.ok(result.warnings.length > 0);
});

test("an archive over the entry limit is bounded, not inflated", async () => {
  const files: Record<string, Uint8Array> = {};
  for (let index = 0; index < 5_100; index += 1) files[`part/${index}.txt`] = strToU8("x");
  const result = await extractDocumentText("docx", Buffer.from(zipSync(files)));
  assert.equal(result.unreadable, true);
  assert.ok(result.warnings.some((warning) => warning.includes("processing limit")), JSON.stringify(result.warnings));
});

test("control characters are stripped from extracted text", async () => {
  const result = await extractDocumentText("docx", docx("<w:p><w:r><w:t>ok\u0007bad</w:t></w:r></w:p>"));
  assert.equal(result.text.includes("\u0007"), false);
  assert.match(result.text, /okbad/);
});

test("large documents are not silently truncated", async () => {
  // No arbitrary text cap: the full body survives. Fitting it into a model
  // call is the harness's context manager's job, not the extractor's.
  const paragraph = "A".repeat(20_000);
  const body = Array.from({ length: 20 }, () => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`).join("");
  const result = await extractDocumentText("docx", docx(`<w:document><w:body>${body}</w:body></w:document>`));
  assert.ok(result.text.length >= 400_000, `expected the full body, got ${result.text.length}`);
  assert.equal(result.warnings.length, 0);
});
