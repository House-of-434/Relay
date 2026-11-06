import {
  stackSchema,
  rowSchema,
  cardSchema,
  metricSchema,
  barChartSchema,
  lineChartSchema,
  pieChartSchema,
  tableSchema,
  badgeSchema,
  calloutSchema,
} from "./schemas/index.ts";

export type ComponentDefinition = {
  name: string;
  description: string;
  props: any;
};

export const componentDefinitions: ComponentDefinition[] = [
  { name: "Stack", description: "Vertical stack layout", props: stackSchema },
  { name: "Row", description: "Horizontal row layout", props: rowSchema },
  { name: "Card", description: "Card container for related content", props: cardSchema },
  { name: "Metric", description: "Single metric display", props: metricSchema },
  { name: "BarChart", description: "Bar chart", props: barChartSchema },
  { name: "LineChart", description: "Line chart", props: lineChartSchema },
  { name: "PieChart", description: "Pie chart", props: pieChartSchema },
  { name: "Table", description: "Data table", props: tableSchema },
  { name: "Badge", description: "Compact status label or colored tag", props: badgeSchema },
  { name: "Callout", description: "Highlighted information, warning, or recommendation", props: calloutSchema },
];

export const v1ComponentNames = new Set(componentDefinitions.map((d) => d.name));
