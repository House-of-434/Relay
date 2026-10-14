/** Pure label assignment for Meet participant tiles.
 *
 *  Two people in a meeting can share a display name. The vendored channel binder
 *  keys speakers by NAME string, so two tiles named "Dana" would collapse into one
 *  speaker (or flip between them) — a WRONG attribution. We cannot tell two same-named
 *  people apart from the DOM, so instead of merging or guessing we DISAMBIGUATE by
 *  tile identity: the first tile (by stable participant id) keeps the name, later ones
 *  get "Name (2)", "Name (3)"… The binder then treats them as distinct speakers.
 *
 *  This is a relay-side helper (the vendored sources stay unedited). If a tile has no
 *  name it is skipped → its channel stays Unknown, never wrong.
 */
export interface GmeetTileLike {
  id: string;
  name: string | null;
  self: boolean;
}

/** Map each non-self, named tile id to the label to use for it.
 *  Unique names keep their name; duplicate names get a stable "Name (n)" suffix
 *  ordered by participant id (so the label is stable across re-scans). */
export function labelsForTiles(tiles: GmeetTileLike[]): Map<string, string> {
  const byName = new Map<string, GmeetTileLike[]>();
  for (const t of tiles) {
    if (t.self || !t.name) continue;
    const list = byName.get(t.name);
    if (list) list.push(t);
    else byName.set(t.name, [t]);
  }
  const out = new Map<string, string>();
  for (const [name, list] of byName) {
    const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
    sorted.forEach((t, i) => out.set(t.id, i === 0 ? name : `${name} (${i + 1})`));
  }
  return out;
}

/** The current set of lit (non-self, named, speaking) tile LABELS. */
export function litLabels(
  tiles: Array<GmeetTileLike & { speaking: boolean }>,
  labels: Map<string, string>,
): string[] {
  const out: string[] = [];
  for (const t of tiles) {
    if (t.self || !t.speaking) continue;
    const label = labels.get(t.id);
    if (label) out.push(label);
  }
  return out;
}
