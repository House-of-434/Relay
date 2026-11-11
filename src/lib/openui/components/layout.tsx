import { defineComponent } from "@openuidev/react-lang";
import React from "react";
import { cardSchema, stackSchema, rowSchema } from "../schemas/index.ts";

const gapMap: Record<string, string> = {
  none: "gap-0",
  xs: "gap-1",
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-6",
};

const gapClass = (gap: string | number | undefined, fallback: string) => {
  if (gap === undefined || gap === null) return fallback;
  if (typeof gap === "number") return `gap-${gap}`;
  if (typeof gap === "string") return gapMap[gap] || "";
  return "";
};

const alignClass = (align: string | undefined) => {
  if (!align) return "";
  if (align === "center") return "items-center";
  if (align === "start") return "items-start";
  if (align === "end") return "items-end";
  if (align === "stretch") return "items-stretch";
  return "";
};

const justifyClass = (justify: string | undefined) => {
  if (!justify) return "";
  if (justify === "center") return "justify-center";
  if (justify === "start") return "justify-start";
  if (justify === "end") return "justify-end";
  if (justify === "between") return "justify-between";
  if (justify === "around") return "justify-around";
  if (justify === "evenly") return "justify-evenly";
  return "";
};

export const Stack = defineComponent({
  name: "Stack",
  description: "Vertical stack layout",
  props: stackSchema,
  component: ({ props, renderNode }: any) =>
    React.createElement(
      "div",
      { className: `flex flex-col ${gapClass(props.gap, "gap-3")} ${alignClass(props.align)} ${justifyClass(props.justify)} min-w-0` },
      renderNode(props.children),
    ),
});

export const Row = defineComponent({
  name: "Row",
  description: "Horizontal row layout",
  props: rowSchema,
  component: ({ props, renderNode }: any) =>
    React.createElement(
      "div",
      { className: `flex flex-row flex-wrap ${gapClass(props.gap, "gap-2")} ${alignClass(props.align)} ${justifyClass(props.justify)} min-w-0` },
      renderNode(props.children),
    ),
});

export const Card = defineComponent({
  name: "Card",
  description: "Card container for related content",
  props: cardSchema,
  component: ({ props, renderNode }: any) =>
    React.createElement(
      "div",
      { className: "rounded-xl bg-card border border-hairline/40 p-3" },
      props.title
        ? React.createElement("div", { className: "text-[13px] font-medium text-ink" }, props.title)
        : null,
      props.subtitle
        ? React.createElement(
            "div",
            { className: props.title ? "mt-0.5 text-[12px] leading-relaxed text-ink-secondary" : "text-[12px] leading-relaxed text-ink-secondary" },
            props.subtitle,
          )
        : null,
      props.children
        ? React.createElement("div", { className: props.title || props.subtitle ? "mt-4" : undefined }, renderNode(props.children))
        : null,
    ),
});
