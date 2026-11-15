// Which place a tool call touched, read from its name alone. Shared by the
// renderer (place icons on tool chips) and any server reader. Names arrive
// namespaced (`mcp__browser__browser_click`, `browser__snapshot`), prefixed
// (`browser_open`) or bare (`agent_browser_open`). The only place left is the
// Tool Layer browser; computer destinations were removed with Works on.

/** The browser tools the Tool Layer exposes. */
export function toolSurfaceKind(toolName: string): "browser" | null {
  const name = toolName.toLowerCase();
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return name.includes("__browser__") || name.startsWith("browser__") ||
    bare.startsWith("browser_") || bare.startsWith("agent_browser_")
    ? "browser"
    : null;
}
