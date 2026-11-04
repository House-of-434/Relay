import { createLibrary } from "@openuidev/react-lang";
import { Stack, Row, Card } from "./components/layout.tsx";
import { Metric, BarChart, LineChart, PieChart } from "./components/analytics.tsx";
import { Table } from "./components/table.tsx";
import { Badge, Callout } from "./components/status.tsx";

export const relayLibrary = createLibrary({
  components: [Stack, Row, Card, Metric, BarChart, LineChart, PieChart, Table, Badge, Callout],
  root: "Stack",
});

export const openUIPrompt = relayLibrary.prompt({
  preamble: "When it improves the response, use the available UI components to present information visually through interactive metrics, charts, tables, or layouts. Choose the appropriate presentation naturally; don't force UI into ordinary conversational answers. Use only supported components and valid syntax.",
});
