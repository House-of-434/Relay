// Shared binary fixtures for attachment-extraction tests.
//
// Real minimal archives, not stubs: the extraction paths under test verify
// magic bytes and parse actual XML, so a fake (`PK` + filler) only exercises
// the malformed-archive branch. Both document-text and gmail-attachments
// tests import from here so a new format adds one builder, not two copies.
import { strToU8, zipSync } from "fflate";

/** A minimal, valid one-page PDF whose content stream draws the given lines.
 * Built here so the test exercises the real pdf parser, not a stub. */
export function minimalPdf(lines: string[]): Buffer {
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Column letters for a zero-based index (0 -> A, 26 -> AA). */
function columnLetters(index: number): string {
  let letters = "";
  let rest = index;
  do {
    letters = String.fromCharCode(65 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return letters;
}

/** A minimal xlsx workbook: one `xl/worksheets/sheetN.xml` per entry (in
 * object order), names in `xl/workbook.xml`, and every string routed
 * through the shared-string table the way real Excel writes them, so tests
 * exercise string resolution rather than inline text. Numbers stay numeric
 * cells, booleans stay boolean cells. */
export function xlsx(sheets: Record<string, Array<Array<string | number | boolean>>>): Buffer {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const sharedId = (value: string): number => {
    const existing = stringIndex.get(value);
    if (existing !== undefined) return existing;
    const id = strings.length;
    strings.push(value);
    stringIndex.set(value, id);
    return id;
  };
  const entries: Record<string, Uint8Array> = {};
  const names = Object.keys(sheets);
  names.forEach((name, sheetPosition) => {
    const sheetRows = sheets[name]!;
    const xmlRows = sheetRows
      .map((cells, rowIndex) => {
        const xmlCells = cells
          .map((cell, cellIndex) => {
            const ref = `${columnLetters(cellIndex)}${rowIndex + 1}`;
            if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
            if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
            return `<c r="${ref}" t="s"><v>${sharedId(cell)}</v></c>`;
          })
          .join("");
        return `<row r="${rowIndex + 1}">${xmlCells}</row>`;
      })
      .join("");
    entries[`xl/worksheets/sheet${sheetPosition + 1}.xml`] =
      strToU8(`<worksheet><sheetData>${xmlRows}</sheetData></worksheet>`);
  });
  entries["xl/workbook.xml"] = strToU8(
    `<workbook><sheets>${names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
  );
  entries["xl/sharedStrings.xml"] = strToU8(
    `<sst count="${strings.length}" uniqueCount="${strings.length}">${strings.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join("")}</sst>`,
  );
  return Buffer.from(zipSync(entries));
}
