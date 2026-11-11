# Boring Avatars

The mascot's body texture is the `pixel` grid ported from Boring Avatars,
<https://github.com/boringdesigners/boring-avatars>, MIT License (see `LICENSE`
in this directory).

The port lives in `src/components/boring-patterns.ts`. It is copied rather than
installed as a dependency because the mascot renderer draws the grid inside its
own clipped silhouette instead of using the library's `<svg>` wrapper.

Changes from upstream:

- Only `pixel` is ported. It reads at small sizes, needs no blur filter to
  repaint, and carries no face of its own.
- Output is inner SVG markup in the variant's own square coordinate space, not
  a full `<svg>`.
