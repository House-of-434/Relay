import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { componentDefinitions } from "../src/lib/openui/definitions.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Generate component signatures from canonical definitions
const signatures = componentDefinitions
  .map((def) => {
    const props = def.props;
    // Extract shape from zod schema
    const shape = props?._def?.shape || props?.shape || {};
    const keys = Object.keys(shape);
    const argList = keys
      .map((key) => {
        const field = shape[key];
        const isOptional = field?.def?.type === "optional";
        const innerType = isOptional ? field.def.innerType : field;
        const typeName = innerType?.def?.type || "any";
        const typeStr = typeName === "string"
          ? "string"
          : typeName === "number"
          ? "number"
          : typeName === "array"
          ? "any[]"
          : typeName === "union"
          ? "string | number"
          : typeName === "any"
          ? "any"
          : typeName === "object"
          ? "object"
          : "any";
        return `${key}${isOptional ? "?" : ""}: ${typeStr}`;
      })
      .join(", ");
    return `${def.name}(${argList}) — ${def.description}`;
  })
  .join("\n");

const prompt = `## OpenUI Generation

When choosing to generate UI, output one fenced \`openui\` code block containing valid OpenUI Lang. Do not output JSX, TSX, HTML, or React components.

### Syntax
- Write statements as \`identifier = Expression\`.
- Assign the final component tree to \`root\`.
- Call components using positional arguments in their documented order.
- Use arrays to compose child components, references to reuse components, and objects for structured data.
- Use double-quoted strings.
- Optional arguments may be omitted from the end.

### Headings
- When a chart or table is inside a titled Card, the Card should own the section heading.
- Omit the chart title when it duplicates the Card title.
- Retain chart titles when standalone or when a distinct title adds useful context.

### Labels
- Keep labels short and recognizable. Use common abbreviations only when the meaning remains clear.
- If labels need truncation, the full label is preserved in a tooltip.

### Data Presentation
- When structured data benefits from visual presentation, use the appropriate OpenUI component.
- When using OpenUI for a table or chart, do not duplicate the same data in a Markdown table.

### Available Components
${signatures}

### Example
root = Stack([metrics, chartCard, tableCard])
metrics = Row([total, locations])
total = Metric("Completed Events", 21)
locations = Metric("Locations", 4)
chartCard = Card([chart], "Events by Location")
chart = BarChart([{label: "New York", value: 9}, {label: "San Francisco", value: 9}])
tableCard = Card([table], "Breakdown")
table = Table([{key: "city", header: "City"}, {key: "events", header: "Events"}], [{city: "New York", events: 9}, {city: "San Francisco", events: 9}])`;

const outPath = resolve(root, "src/lib/openui-meta/openui-prompt.generated.txt");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, prompt, "utf8");
console.log("generated", outPath);
