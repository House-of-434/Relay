import { defineComponent } from "@openuidev/react-lang";
import React from "react";
import { badgeSchema, calloutSchema } from "../schemas/index.ts";

const badgeVariants: Record<string, { bg: string; text: string; border: string }> = {
  success: { bg: "bg-accent/15", text: "text-accent-text", border: "border-accent/30" },
  warning: { bg: "bg-warning/15", text: "text-warning", border: "border-warning/30" },
  danger: { bg: "bg-danger/15", text: "text-danger", border: "border-danger/30" },
  info: { bg: "bg-accent/10", text: "text-accent-text", border: "border-accent/20" },
  neutral: { bg: "bg-raised", text: "text-ink-secondary", border: "border-hairline/40" },
};

const calloutVariants: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  info: { bg: "bg-accent/10", border: "border-accent/30", text: "text-ink", icon: "\u2139" },
  success: { bg: "bg-success/10", border: "border-success/30", text: "text-ink", icon: "\u2713" },
  warning: { bg: "bg-warning/10", border: "border-warning/30", text: "text-ink", icon: "\u26A0" },
  danger: { bg: "bg-danger/10", border: "border-danger/30", text: "text-ink", icon: "\u2715" },
};

export const Badge = defineComponent({
  name: "Badge",
  description: "Compact status label or colored tag",
  props: badgeSchema,
  component: ({ props }: any) => {
    const variant = props.variant || "neutral";
    const v = badgeVariants[variant] || badgeVariants.neutral;
    return React.createElement(
      "span",
      { className: `inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border ${v.bg} ${v.text} ${v.border}` },
      props.text,
    );
  },
});

export const Callout = defineComponent({
  name: "Callout",
  description: "Highlighted information, warning, or recommendation",
  props: calloutSchema,
  component: ({ props }: any) => {
    const variant = props.variant || "info";
    const v = calloutVariants[variant] || calloutVariants.info;
    return React.createElement(
      "div",
      { className: `rounded-lg border ${v.border} ${v.bg} p-3 flex gap-2 items-start` },
      React.createElement("span", { className: `text-[14px] leading-none mt-0.5 ${v.text}`, "aria-hidden": "true" }, v.icon),
      React.createElement("div", { className: `text-[12px] leading-relaxed ${v.text}` }, props.text),
    );
  },
});
