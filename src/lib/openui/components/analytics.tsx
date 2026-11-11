import { metricSchema, barChartSchema, lineChartSchema, pieChartSchema } from "../schemas/index.ts";
import { defineComponent } from "@openuidev/react-lang";
import React, { useLayoutEffect, useRef, useState } from "react";

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

type Datum = { label: string; value: number };

const LABEL_FONT_PX = 9;
const LABEL_CHAR_PX = LABEL_FONT_PX * 0.58;

/** Rough rendered width of an x-axis label at the chart's 9px type. */
function labelWidth(label: string): number {
  return Math.min(120, Math.max(16, label.length * LABEL_CHAR_PX));
}

/** The card's content width, so a chart fills it instead of stopping at a
 * fixed pixel size. 0 until measured (streaming, static render). */
function useChartWidth(minWidth: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setMeasured(el.getBoundingClientRect().width);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, Math.max(Math.round(measured) || 0, minWidth)];
}

function BarChartView({ data, title }: { data: Datum[]; title?: string }) {
  const max = getMax(data);
  const height = 100;
  const topPadding = 14;
  const [ref, chartWidth] = useChartWidth(Math.max(data.length * 64, 160));
  const slot = chartWidth / Math.max(data.length, 1);
  // Rotate the labels the moment their glyphs would run into the next slot.
  const crowded = data.some((d) => labelWidth(String(d.label)) + 6 > slot);
  const bottomPadding = crowded ? 44 : 24;
  const viewBoxHeight = height + topPadding + bottomPadding;
  const barWidth = Math.max(8, Math.min(28, slot * 0.55));

  return React.createElement(
    "div",
    { className: "p-2" },
    title ? React.createElement("div", { className: "mb-2 text-[12px] font-semibold text-ink" }, title) : null,
    React.createElement(
      "div",
      { ref, className: "w-full min-w-0" },
      React.createElement(
        "div",
        { className: "overflow-x-auto", style: { WebkitOverflowScrolling: "touch", touchAction: "pan-x" } },
        React.createElement(
          "div",
          { style: { width: chartWidth } },
          React.createElement(
            "svg",
            { viewBox: `0 0 ${chartWidth} ${viewBoxHeight}`, className: "h-auto", style: { width: "100%" }, role: "img", "aria-label": title || "Bar chart", preserveAspectRatio: "xMidYMid meet" },
            data.map((d, i) => {
              const val = typeof d.value === "number" ? d.value : 0;
              const barH = val > 0 ? (val / max) * height : 0;
              const x = i * slot + (slot - barWidth) / 2;
              const center = i * slot + slot / 2;
              const y = topPadding + (height - barH);
              const zeroY = topPadding + height - 2;
              const labelY = topPadding + height + (crowded ? 16 : 12);
              const labelX = crowded ? center + 2 : center;
              return React.createElement(
                React.Fragment,
                { key: i },
                val > 0
                  ? React.createElement("rect", { x, y, width: barWidth, height: barH, className: "fill-accent", rx: 3 })
                  : React.createElement("rect", { x, y: zeroY, width: barWidth, height: 2, className: "fill-ink-secondary/40", rx: 1 }),
                React.createElement(
                  "text",
                  {
                    x: labelX,
                    y: labelY,
                    textAnchor: crowded ? "end" : "middle",
                    transform: crowded ? `rotate(-40 ${labelX} ${labelY})` : undefined,
                    className: "fill-ink-secondary",
                    style: { fontSize: `${LABEL_FONT_PX}px` },
                  },
                  String(d.label),
                ),
                val > 0
                  ? React.createElement("text", { x: center, y: y - 4, textAnchor: "middle", className: "fill-ink", style: { fontSize: "9px", fontWeight: 500 } }, String(val))
                  : React.createElement("text", { x: center, y: zeroY - 4, textAnchor: "middle", className: "fill-ink-secondary", style: { fontSize: "8px" } }, "0"),
              );
            }),
          ),
        ),
      ),
    ),
  );
}

export const BarChart = defineComponent({
  name: "BarChart",
  description: "Bar chart",
  props: barChartSchema,
  component: ({ props }: any) =>
    React.createElement(BarChartView, {
      data: Array.isArray(props.data) ? props.data : [],
      title: props.title,
    }),
});

function LineChartView({ data, title }: { data: Datum[]; title?: string }) {
  const max = getMax(data);
  const height = 100;
  const topPadding = 10;
  const [ref, width] = useChartWidth(Math.max(data.length * 48, 200));
  if (data.length === 0) {
    return React.createElement("div", { className: "p-2 text-ink-secondary text-[12px]" }, "No data");
  }
  const sidePad = Math.min(24, Math.max(8, width * 0.06));
  const span = Math.max(width - 2 * sidePad, 1);
  const slot = data.length > 1 ? span / (data.length - 1) : width;
  const crowded = data.some((d) => labelWidth(String(d.label)) + 6 > slot);
  const bottomPadding = crowded ? 44 : 24;
  const viewBoxHeight = height + topPadding + bottomPadding;
  const xAt = (i: number) => (data.length > 1 ? sidePad + (i / (data.length - 1)) * span : width / 2);
  const yAt = (d: Datum) => topPadding + height - ((typeof d.value === "number" ? d.value : 0) / max) * (height - 20) - 10;
  const points = data.map((d, i) => `${xAt(i)},${yAt(d)}`).join(" ");
  const labelY = topPadding + height + (crowded ? 16 : 14);

  return React.createElement(
    "div",
    { className: "p-2" },
    title ? React.createElement("div", { className: "mb-2 text-[12px] font-semibold text-ink" }, title) : null,
    React.createElement(
      "div",
      { ref, className: "w-full min-w-0" },
      React.createElement(
        "div",
        { className: "overflow-x-auto", style: { WebkitOverflowScrolling: "touch", touchAction: "pan-x" } },
        React.createElement(
          "div",
          { style: { width } },
          React.createElement(
            "svg",
            { viewBox: `0 0 ${width} ${viewBoxHeight}`, className: "h-auto", style: { width: "100%" }, role: "img", "aria-label": title || "Line chart", preserveAspectRatio: "xMidYMid meet" },
            React.createElement("polyline", { points, fill: "none", stroke: "currentColor", className: "stroke-accent", strokeWidth: "2" }),
            data.map((d, i) => React.createElement("circle", { key: i, cx: xAt(i), cy: yAt(d), r: 3, className: "fill-accent" })),
            data.map((d, i) => {
              const x = xAt(i);
              return React.createElement(
                "text",
                {
                  key: `l${i}`,
                  x: crowded ? x + 2 : x,
                  y: labelY,
                  textAnchor: crowded ? "end" : "middle",
                  transform: crowded ? `rotate(-40 ${x + 2} ${labelY})` : undefined,
                  className: "fill-ink-secondary",
                  style: { fontSize: `${LABEL_FONT_PX}px` },
                },
                String(d.label),
              );
            }),
          ),
        ),
      ),
    ),
  );
}

export const LineChart = defineComponent({
  name: "LineChart",
  description: "Line chart",
  props: lineChartSchema,
  component: ({ props }: any) =>
    React.createElement(LineChartView, {
      data: Array.isArray(props.data) ? props.data : [],
      title: props.title,
    }),
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
