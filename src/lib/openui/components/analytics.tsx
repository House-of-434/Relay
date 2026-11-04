import { metricSchema, barChartSchema, lineChartSchema, pieChartSchema } from "../schemas/index.ts";
import { defineComponent } from "@openuidev/react-lang";
import React from "react";

export const Metric = defineComponent({
  name: "Metric",
  description: "Single metric display",
  props: metricSchema,
  component: ({ props }: any) =>
    React.createElement(
      "div",
      { className: "rounded-xl bg-card border border-hairline/40 p-3" },
      React.createElement("div", { className: "text-[11px] text-ink-secondary" }, props.label),
      React.createElement("div", { className: "mt-0.5 text-[20px] font-semibold text-ink" }, props.value),
      props.delta ? React.createElement("div", { className: "mt-0.5 text-[11px] text-ink-secondary" }, props.delta) : null,
    ),
});

function getMax(data: Array<{ label: string; value: number }>) {
  if (!data.length) return 1;
  return Math.max(...data.map((d) => (typeof d.value === "number" ? d.value : 0)), 1);
}

export const BarChart = defineComponent({
  name: "BarChart",
  description: "Bar chart",
  props: barChartSchema,
  component: ({ props }: any) => {
    const data = Array.isArray(props.data) ? props.data : [];
    const max = getMax(data);
    const height = 100;
    const topPadding = 14;
    const bottomPadding = 24;
    const barWidth = 28;
    const gap = 16;
    const minPerBar = 64;
    const chartWidth = Math.max(data.length * (barWidth + gap) + gap, data.length > 0 ? data.length * minPerBar : 160);
    const viewBoxHeight = height + topPadding + bottomPadding;

    return React.createElement(
      "div",
      { className: "p-2" },
      props.title ? React.createElement("div", { className: "mb-2 text-[12px] font-semibold text-ink" }, props.title) : null,
      React.createElement(
        "div",
        { className: "overflow-x-auto", style: { WebkitOverflowScrolling: "touch", touchAction: "pan-x" } },
        React.createElement(
          "div",
          { style: { minWidth: chartWidth, width: chartWidth } },
          React.createElement(
            "svg",
            { viewBox: `0 0 ${chartWidth} ${viewBoxHeight}`, className: "h-auto", style: { width: "100%", maxWidth: "100%" }, role: "img", "aria-label": props.title || "Bar chart", preserveAspectRatio: "xMidYMid meet" },
            data.map((d: any, i: number) => {
              const val = typeof d.value === "number" ? d.value : 0;
              const barH = val > 0 ? (val / max) * height : 0;
              const x = gap + i * (barWidth + gap);
              const y = topPadding + (height - barH);
              const zeroY = topPadding + height - 2;
              const label = String(d.label);
              return React.createElement(
                React.Fragment,
                { key: i },
                val > 0
                  ? React.createElement("rect", { x, y, width: barWidth, height: barH, className: "fill-accent", rx: 3 })
                  : React.createElement("rect", { x, y: zeroY, width: barWidth, height: 2, className: "fill-ink-secondary/40", rx: 1 }),
                React.createElement("text", { x: x + barWidth / 2, y: topPadding + height + 12, textAnchor: "middle", className: "fill-ink-secondary", style: { fontSize: "9px" } }, label),
                val > 0
                  ? React.createElement("text", { x: x + barWidth / 2, y: y - 4, textAnchor: "middle", className: "fill-ink", style: { fontSize: "9px", fontWeight: 500 } }, String(val))
                  : React.createElement("text", { x: x + barWidth / 2, y: zeroY - 4, textAnchor: "middle", className: "fill-ink-secondary", style: { fontSize: "8px" } }, "0"),
              );
            }),
          ),
        ),
      ),
    );
  },
});

export const LineChart = defineComponent({
  name: "LineChart",
  description: "Line chart",
  props: lineChartSchema,
  component: ({ props }: any) => {
    const data = Array.isArray(props.data) ? props.data : [];
    const max = getMax(data);
    const height = 100;
    const topPadding = 10;
    const bottomPadding = 20;
    const pointSpacing = 48;
    const minChartWidth = 200;
    const width = Math.max(data.length * pointSpacing, minChartWidth);
    if (data.length === 0) {
      return React.createElement("div", { className: "p-2 text-ink-secondary text-[12px]" }, "No data");
    }
    const points = data
      .map((d: any, i: number) => {
        const x = (i / Math.max(data.length - 1, 1)) * (width - 40) + 20;
        const y = topPadding + height - ((typeof d.value === "number" ? d.value : 0) / max) * (height - 20) - 10;
        return `${x},${y}`;
      })
      .join(" ");
    return React.createElement(
      "div",
      { className: "p-2" },
      props.title ? React.createElement("div", { className: "mb-2 text-[12px] font-semibold text-ink" }, props.title) : null,
      React.createElement(
        "div",
        { className: "overflow-x-auto", style: { WebkitOverflowScrolling: "touch", touchAction: "pan-x" } },
        React.createElement(
          "div",
          { style: { minWidth: width, width: width } },
          React.createElement(
            "svg",
            { viewBox: `0 0 ${width} ${height + topPadding + bottomPadding}`, className: "h-auto", style: { width: "100%", maxWidth: "100%" }, role: "img", "aria-label": props.title || "Line chart", preserveAspectRatio: "xMidYMid meet" },
            React.createElement("polyline", { points, fill: "none", stroke: "currentColor", className: "stroke-accent", strokeWidth: "2" }),
            data.map((d: any, i: number) => {
              const x = (i / Math.max(data.length - 1, 1)) * (width - 40) + 20;
              const y = topPadding + height - ((typeof d.value === "number" ? d.value : 0) / max) * (height - 20) - 10;
              return React.createElement("circle", { key: i, cx: x, cy: y, r: 3, className: "fill-accent" });
            }),
            data.map((d: any, i: number) => {
              const x = (i / Math.max(data.length - 1, 1)) * (width - 40) + 20;
              return React.createElement("text", { key: `l${i}`, x, y: topPadding + height + 14, textAnchor: "middle", className: "fill-ink-secondary", style: { fontSize: "9px" } }, d.label);
            }),
          ),
        ),
      ),
    );
  },
});

export const PieChart = defineComponent({
  name: "PieChart",
  description: "Pie chart",
  props: pieChartSchema,
  component: ({ props }: any) => {
    const data = Array.isArray(props.data) ? props.data : [];
    const total = data.reduce((sum: number, d: any) => sum + (typeof d.value === "number" ? d.value : 0), 0) || 1;
    let angle = 0;
    const radius = 40;
    const cx = 50;
    const cy = 50;
    const slices = data.map((d: any, i: number) => {
      const val = typeof d.value === "number" ? d.value : 0;
      const sliceAngle = (val / total) * 360;
      const startAngle = angle;
      angle += sliceAngle;
      const x1 = cx + radius * Math.cos((Math.PI * startAngle) / 180);
      const y1 = cy + radius * Math.sin((Math.PI * startAngle) / 180);
      const x2 = cx + radius * Math.cos((Math.PI * angle) / 180);
      const y2 = cy + radius * Math.sin((Math.PI * angle) / 180);
      const ix1 = cx + 20 * Math.cos((Math.PI * startAngle) / 180);
      const iy1 = cy + 20 * Math.sin((Math.PI * startAngle) / 180);
      const ix2 = cx + 20 * Math.cos((Math.PI * angle) / 180);
      const iy2 = cy + 20 * Math.sin((Math.PI * angle) / 180);
      const largeArc = sliceAngle > 180 ? 1 : 0;
      const pathData = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${20} ${20} 0 ${largeArc} 0 ${ix1} ${iy1} Z`;
      const pct = Math.round((val / total) * 100);
      return { pathData, label: d.label, value: val, pct, i };
    });
    const colors = ["#1c7a4c", "#3fae6e", "#7bd8a8", "#0f5c36", "#2f6b4f", "#5a9e7a"];
    return React.createElement(
      "div",
      { className: "p-2" },
      props.title ? React.createElement("div", { className: "mb-1.5 text-[12px] font-semibold text-ink" }, props.title) : null,
      React.createElement(
        "div",
        { className: "flex items-center gap-4" },
        React.createElement(
          "svg",
          { viewBox: "0 0 100 100", className: "w-full h-auto max-w-[100px] flex-shrink-0", role: "img", "aria-label": props.title || "Pie chart" },
          slices.map((s: any) =>
            React.createElement("path", { key: s.i, d: s.pathData, fill: colors[s.i % colors.length], stroke: "var(--color-card, #fff)", strokeWidth: 1 }),
          ),
          React.createElement("text", { x: cx, y: cy - 2, textAnchor: "middle", className: "fill-ink", style: { fontSize: "12px", fontWeight: 600 } }, String(total)),
          React.createElement("text", { x: cx, y: cy + 8, textAnchor: "middle", className: "fill-ink-secondary", style: { fontSize: "8px" } }, "total"),
        ),
        React.createElement(
          "div",
          { className: "flex flex-col gap-1.5 min-w-0" },
          slices.map((s: any) =>
            React.createElement("div", { key: s.i, className: "flex items-center gap-2 text-[11px] text-ink-secondary" },
              React.createElement("span", { className: "inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0", style: { backgroundColor: colors[s.i % colors.length] } }),
              React.createElement("span", { className: "truncate" }, `${s.label} \u2014 ${s.value} \u2014 ${s.pct}%`),
            ),
          ),
        ),
      ),
    );
  },
});
