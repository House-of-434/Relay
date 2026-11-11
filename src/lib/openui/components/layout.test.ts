import { describe, expect, it } from "vitest";
import { Row, Stack } from "./layout.tsx";

function classesOf(component: { component: (props: any) => any }, props: Record<string, unknown>): string[] {
  const element = component.component({ props, renderNode: () => null });
  return String(element.props.className).split(/\s+/).filter(Boolean);
}

describe("OpenUI layout defaults", () => {
  it("spaces Stack children when the model omits gap", () => {
    expect(classesOf(Stack, { children: [] })).toContain("gap-3");
  });

  it("lets a Stack opt out of spacing", () => {
    expect(classesOf(Stack, { gap: "none" })).toContain("gap-0");
  });

  it("still maps named and numeric gaps", () => {
    expect(classesOf(Stack, { gap: "md" })).toContain("gap-4");
    expect(classesOf(Row, { gap: 2 })).toContain("gap-2");
  });

  it("spaces Row children when the model omits gap", () => {
    expect(classesOf(Row, { children: [] })).toContain("gap-2");
  });
});
