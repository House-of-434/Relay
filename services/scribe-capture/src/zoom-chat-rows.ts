export interface AttrSnapshot {
  id: string | null;
  mid: string | null;
  messageId: string | null;
}

export function platformIdFromAttrs(a: AttrSnapshot): string | null {
  if (a.mid?.trim()) return a.mid.trim();
  if (a.messageId?.trim()) return a.messageId.trim();
  const id = a.id?.trim();
  if (id && id.startsWith("chat-message-")) return id;
  return null;
}

export function pickStamp(values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    const t = v?.trim();
    if (t) return t;
  }
  return null;
}

export interface ChatRowIdentity {
  platformId: string | null;
  stamp: string | null;
  index: number;
  sender: string;
  text: string;
}

export function chatRowKey(r: ChatRowIdentity): string {
  if (r.platformId) return `id:${r.platformId}`;
  if (r.stamp) return `content:${r.stamp}\u0000${r.sender}\u0000${r.text}`;
  return `row:${r.index}\u0000${r.sender}\u0000${r.text}`;
}

export function assignRowKeys(rows: ChatRowIdentity[]): string[] {
  const counts = new Map<string, number>();
  return rows.map((r) => {
    const base = chatRowKey(r);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return n === 0 ? base : `${base}\u0000#${n + 1}`;
  });
}

const TIMESTAMP_FRAG = /^\d{1,2}:\d{2}/;

function stripTrailingStamp(s: string): string {
  return s.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i, "").trim();
}

export function resolveFallbackText(frags: string[], sender: string, senderFound: boolean): string | null {
  if (!senderFound) return null;
  let best: string | null = null;
  for (const f of frags) {
    if (f === sender || TIMESTAMP_FRAG.test(f)) continue;
    if (stripTrailingStamp(f) === sender) continue;
    if (best === null || f.length > best.length) best = f;
  }
  return best;
}

export function unionRows<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const list of lists) {
    for (const row of list) {
      if (seen.has(row)) continue;
      seen.add(row);
      out.push(row);
    }
  }
  return out;
}

export function dropNested<T>(rows: T[], parentOf: (node: T) => T | null): T[] {
  const set = new Set(rows);
  return rows.filter((row) => {
    let p = parentOf(row);
    while (p) {
      if (set.has(p)) return false;
      p = parentOf(p);
    }
    return true;
  });
}
