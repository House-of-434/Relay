export type FileKind = "image" | "pdf" | "text" | "other";

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const TEXT_EXTENSION = /\.(?:md|markdown|txt|csv|tsv|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|css|html?|xml|ya?ml|toml|sh|bash|zsh|sql|log)$/i;

/** One classification for the icons and preview routes. */
export function fileKind(name: string, mime = ""): FileKind {
  const type = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/") || IMAGE_EXTENSION.test(name)) return "image";
  if (type === "application/pdf" || PDF_EXTENSION.test(name)) return "pdf";
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXTENSION.test(name)) return "text";
  return "other";
}
