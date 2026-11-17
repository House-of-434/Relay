import { FileCode2, FileImage, FileText } from "lucide-react";

import { cn } from "@/lib/cn";
import { fileKind } from "@/lib/file-kind";

export function FileTypeIcon({
  name,
  mime,
  size = 16,
  className,
}: {
  name: string;
  mime?: string;
  size?: number;
  className?: string;
}) {
  const kind = fileKind(name, mime);
  const Icon = kind === "image" ? FileImage : kind === "text" ? FileCode2 : FileText;
  return <Icon size={size} className={cn("shrink-0 text-ink-secondary", className)} />;
}
