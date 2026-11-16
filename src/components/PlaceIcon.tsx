import { Globe, type LucideProps } from "lucide-react";
import type { EffectivePlace } from "@/lib/place";

const ICONS = { browser: Globe } as const;

export function PlaceIcon({ place, ...props }: { place: EffectivePlace } & LucideProps) {
  const Icon = ICONS[place];
  return <Icon {...props} />;
}
