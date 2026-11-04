import { z } from "zod/v4";

export const stackSchema = z
  .object({
    children: z.any().optional(),
    gap: z.union([z.string(), z.number()]).optional(),
    align: z.string().optional(),
    justify: z.string().optional(),
  })
  .passthrough();

export const rowSchema = z
  .object({
    children: z.any().optional(),
    gap: z.union([z.string(), z.number()]).optional(),
    align: z.string().optional(),
    justify: z.string().optional(),
  })
  .passthrough();

export const columnSchema = z
  .object({
    children: z.any().optional(),
  })
  .passthrough();

export const cardSchema = z
  .object({
    children: z.any().optional(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
  })
  .passthrough();

export const metricSchema = z
  .object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
    delta: z.string().optional(),
  })
  .passthrough();

export const dataPointSchema = z.object({
  label: z.string(),
  value: z.number(),
});

export const barChartSchema = z
  .object({
    data: z.array(dataPointSchema),
    title: z.string().optional(),
  })
  .passthrough();

export const lineChartSchema = z
  .object({
    data: z.array(dataPointSchema),
    title: z.string().optional(),
  })
  .passthrough();

export const pieChartSchema = z
  .object({
    data: z.array(dataPointSchema),
    title: z.string().optional(),
  })
  .passthrough();

export const tableSchema = z
  .object({
    columns: z.array(z.object({ key: z.string(), header: z.string() })),
    rows: z.array(z.record(z.string(), z.any())),
  })
  .passthrough();

export const badgeSchema = z.object({
  text: z.string(),
  variant: z.enum(["success", "warning", "danger", "info", "neutral"]).optional(),
});

export const calloutSchema = z.object({
  text: z.string(),
  variant: z.enum(["info", "success", "warning", "danger"]).optional(),
});
