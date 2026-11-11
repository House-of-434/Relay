export const openUIPrompt = `## OpenUI Generation

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

### Spacing
- Stack and Row already space their children; pass \`gap\` to tune it and \`gap="none"\` only when children must sit flush.

### Available Components
Stack(children?: any, gap?: string | number, align?: string, justify?: string) — Vertical stack layout
Row(children?: any, gap?: string | number, align?: string, justify?: string) — Horizontal row layout
Card(children?: any, title?: string, subtitle?: string) — Card container for related content
Metric(label: string, value: string | number, delta?: string) — Single metric display
BarChart(data: any[], title?: string) — Bar chart
LineChart(data: any[], title?: string) — Line chart
PieChart(data: any[], title?: string) — Pie chart
Table(columns: any[], rows: any[]) — Data table
Badge(text: string, variant?: any) — Compact status label or colored tag
Callout(text: string, variant?: any) — Highlighted information, warning, or recommendation

### Example
root = Stack([metrics, chartCard, tableCard])
metrics = Row([total, locations])
total = Metric("Completed Events", 21)
locations = Metric("Locations", 4)
chartCard = Card([chart], "Events by Location")
chart = BarChart([{label: "New York", value: 9}, {label: "San Francisco", value: 9}])
tableCard = Card([table], "Breakdown")
table = Table([{key: "city", header: "City"}, {key: "events", header: "Events"}], [{city: "New York", events: 9}, {city: "San Francisco", events: 9}])`;
