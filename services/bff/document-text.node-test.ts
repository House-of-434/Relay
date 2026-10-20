import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";

import { extractDocumentText } from "./document-text.ts";
import { minimalPdf, xlsx } from "./test-document-fixtures.ts";

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

test("XLSX sheets are extracted as TSV with sheet boundaries", async () => {
  const result = await extractDocumentText(
    "xlsx",
    xlsx({ Q1: [["rep", "deal"], ["amy", 7]], Q2: [["note", true]] }),
  );
  assert.equal(result.unreadable, undefined);
  assert.match(result.text, /--- sheet 1: Q1 ---/);
  assert.match(result.text, /rep\tdeal/);
  assert.match(result.text, /amy\t7/);
  assert.match(result.text, /--- sheet 2: Q2 ---/);
  assert.match(result.text, /note\tTRUE/);
});

test("XLSX resolves shared strings, inline strings, booleans, and cached formula values", async () => {
  const bytes = Buffer.from(zipSync({
    "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="Mix" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/sharedStrings.xml": strToU8(`<sst count="2" uniqueCount="2"><si><t>Hello</t></si><si><t>R&amp;D</t></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(
      `<worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>fresh</t></is></c><c r="B2" t="b"><v>0</v></c></row>` +
      `<row r="3"><c r="A3"><f>SUM(1,2)</f><v>3</v></c><c r="B3" t="e"><v>#DIV/0!</v></c></row>` +
      `</sheetData></worksheet>`,
    ),
  }));
  const result = await extractDocumentText("xlsx", bytes);
  assert.equal(result.unreadable, undefined);
  assert.match(result.text, /--- sheet 1: Mix ---/);
  assert.match(result.text, /Hello\tR&D/);
  assert.match(result.text, /fresh\tFALSE/);
  // Cached formula results are kept; the formula text itself is dropped.
  assert.match(result.text, /\n3\t?$/);
  assert.doesNotMatch(result.text, /SUM/);
  assert.doesNotMatch(result.text, /DIV\/0/);
});

test("XLSX sparse cells keep column alignment without trailing tabs", async () => {
  const bytes = Buffer.from(zipSync({
    "xl/worksheets/sheet1.xml": strToU8(
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c>` +
      `<c r="C1" t="inlineStr"><is><t>c</t></is></c><c r="D1"/></row></sheetData></worksheet>`,
    ),
  }));
  const result = await extractDocumentText("xlsx", bytes);
  assert.equal(result.unreadable, undefined);
  assert.match(result.text, /a\t\tc/);
  assert.doesNotMatch(result.text, /\t$/m);
});

test("XLSX dates stay serial and sheet names decode entities", async () => {
  const result = await extractDocumentText("xlsx", xlsx({ "R&D": [[44927, "x"]] }));
  assert.equal(result.unreadable, undefined);
  assert.match(result.text, /--- sheet 1: R&D ---/);
  assert.match(result.text, /44927\tx/);
});

test("a workbook with sheets but no values reports noText without failing", async () => {
  const result = await extractDocumentText("xlsx", xlsx({ Empty: [] }));
  assert.equal(result.noText, true);
  assert.match(result.text, /--- sheet 1: Empty ---/);
});

test("a workbook with no sheets reports unreadable rather than empty success", async () => {
  const result = await extractDocumentText("xlsx", xlsx({}));
  assert.equal(result.unreadable, true);
  assert.equal(result.text, "");
});

test("a malformed xlsx archive is reported unreadable, never thrown", async () => {
  const result = await extractDocumentText("xlsx", Buffer.from("PK\x03\x04 not really a zip"));
  assert.equal(result.unreadable, true);
  assert.ok(result.warnings.length > 0);
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
