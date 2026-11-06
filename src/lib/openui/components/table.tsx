import { tableSchema } from "../schemas/index.ts";
import { defineComponent } from "@openuidev/react-lang";
import React from "react";

export const Table = defineComponent({
  name: "Table",
  description: "Data table",
  props: tableSchema,
  component: ({ props }: any) => {
    const columns = Array.isArray(props.columns) ? props.columns : [];
    const rows = Array.isArray(props.rows) ? props.rows : [];
    return React.createElement(
      "div",
      { className: "overflow-x-auto" },
      React.createElement(
        "table",
        { className: "w-full text-[13px]" },
        React.createElement(
          "thead",
          { className: "bg-raised/30" },
          React.createElement(
            "tr",
            null,
            columns.map((col: any, i: number) =>
              React.createElement("th", { key: i, className: "px-3 py-2 text-left font-medium text-ink" }, col.header || col.key),
            ),
          ),
        ),
        React.createElement(
          "tbody",
          null,
          rows.map((row: any, r: number) =>
            React.createElement(
              "tr",
              { key: r, className: "border-t border-hairline/30" },
              columns.map((col: any, c: number) =>
                React.createElement("td", { key: c, className: "px-3 py-2 text-ink" }, row[col.key] ?? ""),
              ),
            ),
          ),
        ),
      ),
    );
  },
});
