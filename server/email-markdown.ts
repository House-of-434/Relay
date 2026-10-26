/** Email-only Markdown rendering.
 *
 * Routed replies leave Relay as real email, so the harness renders the model's
 * Markdown once into both representations: a conservative HTML body for mail
 * clients and a readable plain-text alternative. Text is escaped and every
 * element comes from this whitelist; raw HTML is never passed through. */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MdNode[];
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  identifier?: string;
  label?: string;
  align?: Array<"left" | "center" | "right" | null> | null;
}

type Definitions = Map<string, string>;

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only absolute web and mail links survive. A relative or script URL keeps
 * its label but never becomes an anchor. */
function safeHref(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function collectDefinitions(tree: MdNode): Definitions {
  const definitions: Definitions = new Map();
  const visit = (node: MdNode): void => {
    if (node.type === "definition" && node.identifier && node.url) {
      definitions.set(node.identifier, node.url);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return definitions;
}

function childrenInline(node: MdNode, definitions: Definitions): string {
  return (node.children ?? []).map((child) => inlineHtml(child, definitions)).join("");
}

function inlineHtml(node: MdNode, definitions: Definitions): string {
  switch (node.type) {
    case "text":
      return escapeHtml(node.value ?? "");
    case "emphasis":
      return `<em>${childrenInline(node, definitions)}</em>`;
    case "strong":
      return `<strong>${childrenInline(node, definitions)}</strong>`;
    case "delete":
      return `<del>${childrenInline(node, definitions)}</del>`;
    case "inlineCode":
      return `<code style="font-family:${MONO};font-size:13px;background:#f6f8fa;padding:1px 4px;border-radius:4px;">${escapeHtml(node.value ?? "")}</code>`;
    case "break":
      return "<br>";
    case "link": {
      const label = childrenInline(node, definitions);
      const href = safeHref(node.url);
      return href ? `<a href="${escapeHtml(href)}" style="color:#0969da;">${label}</a>` : label;
    }
    case "linkReference": {
      const label = childrenInline(node, definitions);
      const href = safeHref(node.identifier ? definitions.get(node.identifier) : undefined);
      return href ? `<a href="${escapeHtml(href)}" style="color:#0969da;">${label}</a>` : label;
    }
    case "image":
    case "imageReference":
      return escapeHtml(node.alt ?? "");
    case "footnoteReference":
      return `<sup>[${escapeHtml(node.label ?? node.identifier ?? "")}]</sup>`;
    case "html":
      return "";
    default:
      return childrenInline(node, definitions);
  }
}

function renderList(node: MdNode, definitions: Definitions): string {
  const ordered = node.ordered === true;
  const tag = ordered ? "ol" : "ul";
  const start = ordered && typeof node.start === "number" && node.start !== 1 ? ` start="${node.start}"` : "";
  const items = (node.children ?? [])
    .filter((child) => child.type === "listItem")
    .map((item) => renderListItem(item, definitions))
    .join("");
  return `<${tag}${start} style="margin:0 0 12px;padding-left:24px;">${items}</${tag}>`;
}

function renderListItem(node: MdNode, definitions: Definitions): string {
  const children = node.children ?? [];
  const onlyParagraph = children.length === 1 && children[0]!.type === "paragraph" ? children[0]! : undefined;
  const body = onlyParagraph
    ? childrenInline(onlyParagraph, definitions)
    : children.map((child) => renderBlock(child, definitions)).join("");
  const task = node.checked === true ? "☑ " : node.checked === false ? "☐ " : "";
  return `<li style="margin:4px 0;">${task}${body}</li>`;
}

function renderTable(node: MdNode, definitions: Definitions): string {
  const rows = (node.children ?? []).filter((child) => child.type === "tableRow");
  if (rows.length === 0) return "";
  const cell = (row: MdNode, index: number, tag: "th" | "td"): string => {
    const value = (row.children ?? [])[index];
    if (!value) return "";
    const align = node.align?.[index] ?? null;
    const style = [
      "border:1px solid #d0d7de",
      "padding:6px 10px",
      `text-align:${align ?? "left"}`,
      ...(tag === "th" ? ["background:#f6f8fa", "font-weight:600"] : []),
    ].join(";");
    return `<${tag} style="${style};">${childrenInline(value, definitions)}</${tag}>`;
  };
  const header = rows[0]!;
  const headCells = (header.children ?? []).map((_, index) => cell(header, index, "th")).join("");
  const bodyRows = rows.slice(1).map((row) => {
    const cells = (row.children ?? []).map((_, index) => cell(row, index, "td")).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;">` +
    `<thead><tr>${headCells}</tr></thead>` +
    (bodyRows ? `<tbody>${bodyRows}</tbody>` : "") +
    `</table>`;
}

function renderBlock(node: MdNode, definitions: Definitions): string {
  switch (node.type) {
    case "paragraph":
      return `<p style="margin:0 0 12px;">${childrenInline(node, definitions)}</p>`;
    case "heading": {
      const level = Math.min(Math.max(node.depth ?? 1, 1), 6);
      const size = [24, 20, 18, 16, 15, 14][level - 1]!;
      return `<h${level} style="margin:18px 0 8px;font-size:${size}px;line-height:1.3;">${childrenInline(node, definitions)}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote style="margin:12px 0;padding:0 0 0 12px;border-left:3px solid #d0d7de;color:#57606a;">${(node.children ?? []).map((child) => renderBlock(child, definitions)).join("")}</blockquote>`;
    case "list":
      return renderList(node, definitions);
    case "code":
      return `<pre style="margin:12px 0;padding:12px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;overflow-x:auto;font-family:${MONO};font-size:13px;line-height:1.45;"><code>${escapeHtml(node.value ?? "")}</code></pre>`;
    case "thematicBreak":
      return `<hr style="border:0;border-top:1px solid #d0d7de;margin:18px 0;">`;
    case "table":
      return renderTable(node, definitions);
    case "html":
    case "definition":
      return "";
    case "footnoteDefinition":
      return `<div style="margin:8px 0;color:#57606a;">[${escapeHtml(node.label ?? node.identifier ?? "")}] ${(node.children ?? []).map((child) => renderBlock(child, definitions)).join("")}</div>`;
    default:
      return node.children?.length
        ? `<p style="margin:0 0 12px;">${childrenInline(node, definitions)}</p>`
        : "";
  }
}

function inlineText(node: MdNode, definitions: Definitions): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value ?? "";
    case "emphasis":
    case "strong":
    case "delete":
      return (node.children ?? []).map((child) => inlineText(child, definitions)).join("");
    case "footnoteReference":
      return `[${node.label ?? node.identifier ?? ""}]`;
    case "link": {
      const label = (node.children ?? []).map((child) => inlineText(child, definitions)).join("");
      const href = safeHref(node.url);
      return href && href !== label.trim() ? `${label} (${href})` : label;
    }
    case "linkReference": {
      const label = (node.children ?? []).map((child) => inlineText(child, definitions)).join("");
      const href = safeHref(node.identifier ? definitions.get(node.identifier) : undefined);
      return href && href !== label.trim() ? `${label} (${href})` : label;
    }
    case "image":
    case "imageReference":
      return node.alt ? `[image: ${node.alt}]` : "[image]";
    case "break":
      return "\n";
    case "html":
      return "";
    default:
      return (node.children ?? []).map((child) => inlineText(child, definitions)).join("");
  }
}

interface TextState {
  out: string[];
  definitions: Definitions;
  quote: number;
}

function textBlock(node: MdNode, state: TextState, listDepth: number): void {
  const prefix = state.quote > 0 ? `${"> ".repeat(state.quote)}` : "";
  switch (node.type) {
    case "paragraph":
    case "heading": {
      const value = (node.children ?? []).map((child) => inlineText(child, state.definitions)).join("");
      state.out.push(`${prefix}${value}\n\n`);
      return;
    }
    case "blockquote": {
      const before = state.out.length;
      state.quote += 1;
      for (const child of node.children ?? []) textBlock(child, state, listDepth);
      state.quote -= 1;
      const body = state.out.splice(before).join("");
      state.out.push(body);
      return;
    }
    case "list": {
      const isOrdered = node.ordered === true;
      const listStart = typeof node.start === "number" ? node.start : 1;
      for (const [itemIndex, child] of (node.children ?? []).entries()) {
        if (child.type !== "listItem") continue;
        const bullet = isOrdered ? `${listStart + itemIndex}. ` : "- ";
        const indent = "  ".repeat(listDepth);
        const before = state.out.length;
        const itemChildren = child.children ?? [];
        for (const itemChild of itemChildren) {
          textBlock(itemChild, state, listDepth + 1);
        }
        const body = state.out.splice(before).join("").trim();
        const task = child.checked === true ? "[x] " : child.checked === false ? "[ ] " : "";
        state.out.push(`\n${indent}${bullet}${task}${body.replace(/\n/g, `\n${indent}  `)}`);
      }
      state.out.push("\n");
      return;
    }
    case "code":
      state.out.push(`${prefix}${node.value ?? ""}\n\n`);
      return;
    case "thematicBreak":
      state.out.push(`${prefix}---\n`);
      return;
    case "table": {
      const rows = (node.children ?? []).filter((child) => child.type === "tableRow");
      const rendered = rows.map((row) =>
        (row.children ?? []).map((cell) => (cell.children ?? []).map((child) => inlineText(child, state.definitions)).join("").trim()).join(" | ")
      );
      if (rendered.length) {
        const widths = rendered[0]!.split(" | ").map((cell) => Math.max(3, cell.length));
        const separator = widths.map((width) => "-".repeat(width)).join(" | ");
        state.out.push(`${prefix}| ${rendered[0]} |\n${prefix}| ${separator} |\n`);
        for (const row of rendered.slice(1)) state.out.push(`${prefix}| ${row} |\n`);
        state.out.push("\n");
      }
      return;
    }
    case "html":
    case "definition":
      return;
    case "footnoteDefinition": {
      const label = node.label ?? node.identifier ?? "";
      state.out.push(`${prefix}[${label}] `);
      for (const child of node.children ?? []) textBlock(child, state, listDepth);
      return;
    }
    default:
      for (const child of node.children ?? []) textBlock(child, state, listDepth);
  }
}

function renderText(tree: MdNode, definitions: Definitions): string {
  const state: TextState = { out: [], definitions, quote: 0 };
  for (const child of tree.children ?? []) textBlock(child, state, 0);
  return state.out.join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parse(markdown: string): MdNode {
  return fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as MdNode;
}

/** Render one Markdown document into the HTML and plain-text parts of an
 * email. Both come from the same tree, so the wording cannot drift. */
export function renderEmailMarkdown(markdown: string): { html: string; text: string } {
  if (!markdown.trim()) return { html: "", text: "" };
  let tree: MdNode;
  try {
    tree = parse(markdown);
  } catch {
    const escaped = escapeHtml(markdown);
    return {
      html: `<div style="font-family:${FONT};font-size:15px;line-height:1.55;color:#1f2328;max-width:680px;"><p style="margin:0 0 12px;">${escaped}</p></div>`,
      text: markdown,
    };
  }
  const definitions = collectDefinitions(tree);
  const body = (tree.children ?? []).map((child) => renderBlock(child, definitions)).join("");
  const text = renderText(tree, definitions);
  if (!body && !text) {
    const escaped = escapeHtml(markdown);
    return {
      html: `<div style="font-family:${FONT};font-size:15px;line-height:1.55;color:#1f2328;max-width:680px;"><p style="margin:0 0 12px;">${escaped}</p></div>`,
      text: markdown,
    };
  }
  const html = body
    ? `<div style="font-family:${FONT};font-size:15px;line-height:1.55;color:#1f2328;max-width:680px;">${body}</div>`
    : "";
  return { html, text };
}

/** Plain-text email rendering, kept as the shared entry point for the question
 * email and for anything that only needs the text half of the renderer. */
export function markdownToPlainText(markdown: string): string {
  return renderEmailMarkdown(markdown).text;
}
