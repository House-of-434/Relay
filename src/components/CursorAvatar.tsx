/**
 * CursorAvatar — an animated mascot built on the "cursor" silhouette.
 *
 * Self-contained: React is the only dependency. Drop this file in and use it.
 *
 *   import CursorAvatar from './CursorAvatar'
 *
 *   <CursorAvatar state="thinking" silhouette={MASCOT_BODIES.cursor} size={160} />
 *
 * The state drives everything — which expressions cycle, how often, and when it blinks.
 * Set `state` and it animates itself; see CURSOR_STATES for the full list.
 *
 * Props of note:
 *   state        one of CURSOR_STATES
 *   expression   pin a single face and stop the cycling
 *   lookAround   how much each expression glances around. 0 = always straight ahead
 *   gaze / turn  aim the eyes, or rotate the head around its implied sphere
 *   showMouth    false for an eyes-only face
 *
 * Made with Blob Studio.
 */
import React, { useEffect, useId, useMemo, useRef } from 'react'

import { MASCOT_BODIES } from "../../shared/mascot-bodies"
import { boringPattern, type BoringVariant } from "./boring-patterns"
import {
  EXPRESSIONS,
  EXPRESSION_COUNT,
  FACE_BOX,
  FACE_CENTRE,
  GAZE,
  GAZE_TRAVEL,
  MOUTHS,
  MOUTH_STROKE,
  mouthFrame,
  type Ring,
} from "./cursor-face-data"

export {
  EXPRESSIONS,
  EXPRESSION_COUNT,
  FACE_BOX,
  FACE_CENTRE,
  GAZE,
  GAZE_TRAVEL,
  MOUTHS,
  MOUTH_STROKE,
  mouthFrame,
}
export type { Ring }

/* ------------------------------------------------------------------- shape */

export interface CursorSilhouette {
  /** Human-readable name, used for the accessible label. */
  name: string
  /** Transform mapping the artwork into the 228.541-unit face box. '' for none. */
  fit: string
  /** SVG markup for the body. The token {{GRADIENT}} is replaced with the instance gradient. */
  body: string
  /** SVG markup defining the clip region — the union of the silhouette's filled shapes. */
  clip: string
  /** Where the face sits inside the silhouette, in face-space units. */
  anchor: { x: number; y: number; scale: number }
}

// The generator solves this body's face placement once; `MASCOT_BODIES.cursor`
// is the single source of truth desktop and iOS both build from. Its shape
// carries one extra field (`id`) that `CursorSilhouette` does not, so it is
// derived here rather than assigned directly.
const { id: _cursorBodyId, ...cursorSilhouette } = MASCOT_BODIES.cursor;
export const DEFAULT_SILHOUETTE: CursorSilhouette = cursorSilhouette;

export const DEFAULT_GRADIENT: [string, string, string] = ["#9FE6B5","#3FAE6E","#1C7A4C"]

const VIEW_BOX = `-15 -15 ${FACE_BOX + 30} ${FACE_BOX + 30}`
const SPHERE_C = 114.2705
const SPHERE_R = 105

/* ------------------------------------------------------------------ motion */

/**
 * How the body itself moves. The face engine on its own leaves the silhouette perfectly
 * still, which reads as dead for states literally named `bouncing` or `spawning`.
 *
 * All of this is shape-agnostic — it moves whatever silhouette it is given, so an uploaded
 * logo animates exactly like the built-in circle.
 *
 *   bob     vertical travel, [amplitude in face units, period ms]
 *   sway    rotation, [degrees, period ms]
 *   pulse   uniform scale, [fraction, period ms] — breathing
 *   circle  orbital drift, [radius, period ms]
 *   jitter  fast nervous shake, [amplitude, period ms]
 *   tilt    constant lean, degrees
 *   squash  0..1, how much a bob squashes the body at the bottom of its arc
 *   enter   one-shot on entering the state, [starting scale, duration ms]
 *   settle  scale it eases to and holds, for exits like powering-down
 */
export interface BodyMotion {
  bob?: [number, number]
  sway?: [number, number]
  pulse?: [number, number]
  circle?: [number, number]
  jitter?: [number, number]
  tilt?: number
  squash?: number
  enter?: [number, number]
  settle?: number
}

export const MOTION = {
  // Lifecycle — quiet, breathing, alive but not busy.
  sleeping: { pulse: [0.028, 4600], tilt: 2 },
  waking: { enter: [0.92, 700], pulse: [0.03, 2200] },
  idle: { pulse: [0.014, 3600] },
  listening: { bob: [2, 2600], pulse: [0.012, 2600] },
  thinking: { sway: [1.6, 3000], pulse: [0.01, 3000] },
  searching: { bob: [3, 1400], sway: [2.2, 1400] },
  working: { bob: [2.5, 900], squash: 0.22 },

  // Reactions — the loud half.
  excited: { bob: [9, 520], sway: [3, 1040], squash: 0.35 },
  surprised: { enter: [1.14, 340], jitter: [0.8, 120] },
  suspicious: { sway: [2.4, 2600], tilt: -3 },
  drowsy: { pulse: [0.026, 5000], tilt: 3 },
  happy: { bob: [5, 820], squash: 0.28 },
  curious: { sway: [3.4, 1900], tilt: -4 },
  proud: { bob: [1.6, 2400], pulse: [0.02, 2400] },
  sad: { pulse: [0.02, 4600], tilt: 3 },
  scared: { jitter: [2.2, 75] },
  playful: { bob: [6, 620], sway: [5, 1240], squash: 0.3 },
  celebrate: { bob: [10, 480], sway: [4, 960], squash: 0.35 },

  // Agent morphs — the mascot standing in for a process.
  radar: { sway: [6, 2400], pulse: [0.012, 2400] },

  // Product cycle.
  spawning: { enter: [0.02, 820], pulse: [0.014, 3600] },
  loading: { sway: [2.2, 1500], pulse: [0.012, 1500] },
  writing: { bob: [1.6, 1100] },
  sending: { bob: [3, 900] },
  notifying: { bob: [4, 700], sway: [2.5, 700] },
  alerting: { jitter: [2.6, 85] },
} satisfies Record<CursorState, BodyMotion>

/** How long a `settle` takes to reach its resting scale. */
const SETTLE_MS = 1400

/* ----------------------------------------------------------------- effects */

/**
 * Confetti, motion ribbons, and glyph morphs.
 *
 * All three are shape-agnostic: they orbit, burst around, or stand in for whatever
 * silhouette they are given, so an uploaded logo behaves exactly like the built-in circle.
 *
 * These layers are driven imperatively from the frame loop rather than through React
 * state. A celebrate burst is ~14 elements changing every frame, and a page showing all
 * states at once would otherwise re-render continuously.
 */

const TAU = Math.PI * 2

/** Deterministic per-particle randomness — same seed, same particle, every run. */
const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

const CONFETTI_COLORS = ['#F472B6', '#C084FC', '#818CF8', '#38BDF8', '#34D399', '#FACC15', '#FB7185']
const RIBBON_COLORS = ['#4ADE80', '#34D399', '#22D3EE', '#60A5FA']

export interface ConfettiSpec {
  /** How many pieces are in flight per burst. */
  count: number
  /** Milliseconds between bursts. */
  period: number
  /** How long one piece lives, ms. */
  life: number
  /** Radius the pieces launch from, so a burst clears the face instead of covering it. */
  origin: number
  /** How far pieces travel beyond that, in face units. */
  spread: number
}

export interface TrailSpec {
  /** How many ribbons orbit the body. */
  count: number
  /** Milliseconds for one full orbit. */
  period: number
  /** Orbit radius, in face units. */
  radius: number
}

export interface GlyphSpec {
  /** Markup drawn in place of the body. {{GRADIENT}} is replaced with the body paint. */
  markup: string
  /** Milliseconds between appearances. */
  period: number
  /** How long the glyph is held, ms. */
  hold: number
}

export interface StateEffects {
  confetti?: ConfettiSpec
  trails?: TrailSpec
  glyph?: GlyphSpec
}

interface EffectsByState extends Partial<Record<CursorState, StateEffects>> {}

/**
 * The exclamation mark the mascot becomes when something needs attention — drawn as a
 * tapered bar and a dot so it reads as a character rather than a rectangle.
 */
const GLYPH_BANG =
  '<path fill="{{GRADIENT}}" d="M99 58 Q99 43 114.3 43 Q129.6 43 129.6 58 L123 150 Q122 161 114.3 161 Q106.6 161 105.6 150 Z"/>' +
  '<circle fill="{{GRADIENT}}" cx="114.3" cy="188" r="15"/>'


export const EFFECTS: EffectsByState = {
  // Celebration — the loud burst.
  // Travel is deliberately bounded: the viewBox only carries 15 units of margin, so a
  // piece thrown much past ~130 from centre would be clipped mid-flight.
  celebrate: { confetti: { count: 16, period: 1500, life: 1300, origin: 74, spread: 54 } },
  excited: { confetti: { count: 9, period: 2000, life: 1100, origin: 72, spread: 44 } },

  // Work in flight — ribbons circling the body.
  radar: { trails: { count: 2, period: 2000, radius: 132 } },
  loading: { trails: { count: 2, period: 2200, radius: 126 } },
  sending: { trails: { count: 2, period: 1500, radius: 120 } },

  // The mascot standing aside to show a symbol.
  alerting: { glyph: { markup: GLYPH_BANG, period: 2600, hold: 1100 } },
  notifying: { glyph: { markup: GLYPH_BANG, period: 4200, hold: 900 } },
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Grows or shrinks a layer's pool of <path> children to exactly `count`. */
function poolPaths(layer: SVGGElement, count: number): SVGPathElement[] {
  while (layer.childNodes.length > count) layer.removeChild(layer.lastChild!)
  while (layer.childNodes.length < count) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('fill', 'none')
    layer.appendChild(path)
  }
  return Array.from(layer.querySelectorAll<SVGPathElement>(':scope > path'))
}

/** Confetti: short curved strokes thrown outward, arcing down as they fade. */
function drawConfetti(
  layer: SVGGElement,
  spec: ConfettiSpec,
  elapsed: number,
  strength: number,
  cx: number,
  cy: number
) {
  const paths = poolPaths(layer, spec.count)
  for (let i = 0; i < spec.count; i++) {
    const path = paths[i]
    const seedA = hash01(i + 1)
    const seedB = hash01(i + 41)
    const seedC = hash01(i + 91)

    // Stagger the pieces across the burst window so they don't leave as one wall.
    const t = (((elapsed + seedC * spec.period) % spec.period) / spec.life) * 1
    if (t > 1) {
      path.setAttribute('opacity', '0')
      continue
    }

    const angle = seedA * TAU
    const travel = spec.spread * (0.45 + seedB * 0.55) * (1 - (1 - t) * (1 - t))
    const distance = (spec.origin + travel) * strength
    const gravity = 34 * strength * t * t
    const x = cx + Math.cos(angle) * distance
    const y = cy + Math.sin(angle) * distance + gravity
    const length = 11 + seedB * 12
    const spin = angle + (seedC - 0.5) * 5 * t
    const ex = x + Math.cos(spin) * length
    const ey = y + Math.sin(spin) * length
    // A slight bend reads as paper rather than a matchstick.
    const bend = (seedA - 0.5) * length * 0.7
    const mx = (x + ex) / 2 - Math.sin(spin) * bend
    const my = (y + ey) / 2 + Math.cos(spin) * bend

    path.setAttribute('d', `M${x.toFixed(1)} ${y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`)
    path.setAttribute('stroke', CONFETTI_COLORS[i % CONFETTI_COLORS.length])
    path.setAttribute('stroke-width', (4 + seedB * 2.4).toFixed(1))
    path.setAttribute('opacity', (t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88).toFixed(3))
  }
}

/** Ribbons: arcs sweeping around the body on their own periods. */
function drawTrails(
  layer: SVGGElement,
  spec: TrailSpec,
  elapsed: number,
  strength: number,
  cx: number,
  cy: number
) {
  const paths = poolPaths(layer, spec.count)
  const SAMPLES = 12
  for (let i = 0; i < spec.count; i++) {
    const path = paths[i]
    const seedA = hash01(i + 3)
    const seedB = hash01(i + 29)
    const direction = i % 2 === 0 ? 1 : -1
    const period = spec.period * (0.8 + seedA * 0.5)
    const radius = spec.radius * strength * (0.78 + seedB * 0.4)
    const start = direction * (elapsed / period) * TAU + seedA * TAU
    const span = 0.85 + seedB * 0.7

    let d = ''
    for (let s = 0; s <= SAMPLES; s++) {
      const k = s / SAMPLES
      const angle = start + span * k
      // Breathe the radius along the arc so the ribbon curls instead of tracing a circle.
      const r = radius * (1 + Math.sin(k * Math.PI) * 0.14)
      const x = cx + Math.cos(angle) * r
      const y = cy + Math.sin(angle) * r * 0.78
      d += (s === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1)
    }
    path.setAttribute('d', d)
    path.setAttribute('stroke', RIBBON_COLORS[i % RIBBON_COLORS.length])
    path.setAttribute('stroke-width', (5 + seedA * 3).toFixed(1))
    path.setAttribute('opacity', '0.85')
  }
}

/** How present the glyph is right now, 0..1, with eased edges. */
function glyphAmount(spec: GlyphSpec, elapsed: number): number {
  const position = elapsed % spec.period
  const start = spec.period - spec.hold
  if (position < start) return 0
  const into = position - start
  const remaining = spec.hold - into
  const EASE = 200
  return Math.max(0, Math.min(1, Math.min(into, remaining) / EASE))
}

export interface EffectFrame {
  trails: SVGGElement | null
  confetti: SVGGElement | null
  glyph: SVGGElement | null
  bodyContent: SVGGElement | null
  state: CursorState
  elapsed: number
  strength: number
  paint: string
  showEffects: boolean
  showGlyphs: boolean
}

/** Called once per frame from the engine loop. */
export function updateEffects(frame: EffectFrame) {
  const spec = EFFECTS[frame.state]
  const centre = FACE_BOX / 2
  const strength = frame.strength

  if (frame.trails) {
    if (spec?.trails && frame.showEffects && strength > 0) {
      drawTrails(frame.trails, spec.trails, frame.elapsed, strength, centre, centre)
    } else if (frame.trails.childNodes.length) {
      frame.trails.replaceChildren()
    }
  }

  if (frame.confetti) {
    if (spec?.confetti && frame.showEffects && strength > 0) {
      drawConfetti(frame.confetti, spec.confetti, frame.elapsed, strength, centre, centre)
    } else if (frame.confetti.childNodes.length) {
      frame.confetti.replaceChildren()
    }
  }

  if (frame.glyph && frame.bodyContent) {
    if (spec?.glyph && frame.showGlyphs) {
      const amount = glyphAmount(spec.glyph, frame.elapsed)
      const markup = spec.glyph.markup.replace(/\{\{GRADIENT\}\}/g, frame.paint)
      if (frame.glyph.getAttribute('data-glyph') !== markup) {
        frame.glyph.setAttribute('data-glyph', markup)
        frame.glyph.innerHTML = markup
      }
      frame.glyph.style.opacity = String(amount)
      // Scale up as it arrives, so the swap reads as a transformation.
      const scale = 0.72 + 0.28 * amount
      frame.glyph.setAttribute(
        'transform',
        `translate(${centre} ${centre}) scale(${scale.toFixed(3)}) translate(${-centre} ${-centre})`
      )
      // The body steps aside rather than sitting behind the glyph.
      frame.bodyContent.style.opacity = String(1 - amount)
    } else {
      if (frame.glyph.getAttribute('data-glyph')) {
        frame.glyph.removeAttribute('data-glyph')
        frame.glyph.replaceChildren()
      }
      frame.glyph.style.opacity = '0'
      frame.bodyContent.style.opacity = '1'
    }
  }
}

/* ------------------------------------------------------------------ states */

export type CursorState =
  | "sleeping"
  | "waking"
  | "idle"
  | "listening"
  | "thinking"
  | "searching"
  | "working"
  | "excited"
  | "surprised"
  | "suspicious"
  | "drowsy"
  | "happy"
  | "curious"
  | "proud"
  | "sad"
  | "scared"
  | "playful"
  | "celebrate"
  | "radar"
  | "spawning"
  | "loading"
  | "sending"
  | "writing"
  | "notifying"
  | "alerting"

/**
 * Which expressions a state cycles through. The first is its resting face, chosen as the
 * pool's most forward-facing member so a mascot at rest looks at you rather than past you.
 */
export const POOLS = {
  sleeping: [
    22,
    13,
    4
  ],
  waking: [
    13
  ],
  idle: [
    6,
    0,
    8
  ],
  listening: [
    1,
    10,
    19
  ],
  thinking: [
    17,
    8,
    16,
    14,
    5
  ],
  searching: [
    20,
    15,
    9,
    3,
    12,
    18
  ],
  working: [
    10,
    7,
    16,
    11
  ],
  excited: [
    2,
    17,
    21,
    3,
    11
  ],
  surprised: [
    21,
    3
  ],
  suspicious: [
    5,
    14,
    23
  ],
  drowsy: [
    22,
    4,
    13
  ],
  happy: [
    19,
    2,
    11,
    17
  ],
  curious: [
    21,
    3,
    0,
    15
  ],
  proud: [
    2,
    15,
    8
  ],
  sad: [
    22,
    4,
    13
  ],
  scared: [
    21,
    3
  ],
  playful: [
    2,
    17,
    11,
    8
  ],
  celebrate: [
    2,
    8,
    17
  ],
  radar: [
    6,
    0,
    8
  ],
  spawning: [
    3,
    0
  ],
  loading: [
    6,
    0,
    8
  ],
  sending: [
    6,
    0,
    8
  ],
  writing: [
    15,
    9
  ],
  notifying: [
    21,
    3,
    0
  ],
  alerting: [
    21,
    3
  ],
} satisfies Record<CursorState, number[]>

/** How long a state holds an expression before drifting to another, in ms. */
const EXPR_CADENCE = {
  sleeping: [
    6000,
    10000
  ],
  waking: [
    800,
    800
  ],
  idle: [
    9000,
    16000
  ],
  listening: [
    2800,
    5000
  ],
  thinking: [
    2000,
    3600
  ],
  searching: [
    1000,
    1800
  ],
  working: [
    1800,
    3200
  ],
  excited: [
    1100,
    2000
  ],
  surprised: [
    2500,
    4000
  ],
  suspicious: [
    2600,
    4500
  ],
  drowsy: [
    4000,
    8000
  ],
  happy: [
    2500,
    4500
  ],
  curious: [
    1800,
    3200
  ],
  proud: [
    3500,
    6000
  ],
  sad: [
    4000,
    7000
  ],
  scared: [
    900,
    1800
  ],
  playful: [
    1500,
    3000
  ],
  celebrate: [
    1400,
    2600
  ],
  radar: [
    4000,
    8000
  ],
  spawning: [
    1200,
    1200
  ],
  loading: [
    6000,
    10000
  ],
  sending: [
    4000,
    8000
  ],
  writing: [
    4000,
    8000
  ],
  notifying: [
    1500,
    2600
  ],
  alerting: [
    2000,
    3600
  ],
} satisfies Record<CursorState, [number, number]>

/** Blink cadence in ms, or null for states that never blink. */
const BLINK = {
  sleeping: null,
  waking: null,
  idle: [
    6000,
    14000
  ],
  listening: [
    3000,
    7000
  ],
  thinking: [
    3500,
    7000
  ],
  searching: [
    1600,
    4000
  ],
  working: [
    2800,
    5500
  ],
  excited: [
    2000,
    4000
  ],
  surprised: [
    1800,
    3500
  ],
  suspicious: [
    4500,
    8000
  ],
  drowsy: null,
  happy: [
    2500,
    5000
  ],
  curious: [
    2500,
    5500
  ],
  proud: [
    3500,
    7000
  ],
  sad: [
    4000,
    8000
  ],
  scared: [
    1200,
    3000
  ],
  playful: [
    2000,
    4500
  ],
  celebrate: [
    2200,
    4500
  ],
  radar: null,
  spawning: null,
  loading: null,
  sending: null,
  writing: null,
  notifying: [
    2000,
    4000
  ],
  alerting: null,
} satisfies Record<CursorState, [number, number] | null>

/** Grouping, for pickers and docs. */
export const STATE_GROUPS = {
  "Cycle de vie": [
    "sleeping",
    "waking",
    "idle",
    "listening",
    "thinking",
    "searching",
    "working"
  ],
  "Réactions": [
    "excited",
    "surprised",
    "suspicious",
    "drowsy",
    "happy",
    "curious",
    "proud",
    "sad",
    "scared",
    "playful",
    "celebrate"
  ],
  "Cycle produit": [
    "spawning",
    "loading",
    "writing",
    "sending",
    "notifying",
    "alerting"
  ]
} satisfies Record<string, CursorState[]>

const isCursorState = (state: string): state is CursorState => state in POOLS
export const CURSOR_STATES = Object.keys(POOLS).filter(isCursorState)

/* ------------------------------------------------------------------- maths */

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const noTimestamp = (): number | null => null

const toPath = (ring: Ring) =>
  'M' + ring.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z'

/** A rounded eye centred on (cx, cy). Two arcs make a full ellipse. */
const dotPath = (cx: number, cy: number, rx: number, ry: number) => {
  const y = cy.toFixed(2)
  return (
    `M${(cx - rx).toFixed(2)} ${y}` +
    `a${rx} ${ry} 0 1 0 ${(rx * 2).toFixed(2)} 0` +
    `a${rx} ${ry} 0 1 0 ${(-rx * 2).toFixed(2)} 0Z`
  )
}

/** Half-width and half-height of the simple dot eye, in face-space units. */
const DOT_EYE = { rx: 9, ry: 13 }

/** The smile is authored small in the expression tables; this widens it to sit
 * under the dot eyes without changing each expression's own character. */
const MOUTH_SCALE = 1.6

const clone = (rings: Ring[]): Ring[] =>
  rings.map(r => r.map((p): [number, number] => [p[0], p[1]]))

/** Ring centroid — same computation cursor-face-data.ts uses for mouthFrame, needed here too for eye projection. */
const ringCentre = (ring: Ring): [number, number] => {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p[0]
    y += p[1]
  }
  return [x / ring.length, y / ring.length]
}

export function mouthPath(frame: { x: number; y: number; angle: number }, spec: number[]) {
  const ca = Math.cos(frame.angle)
  const sa = Math.sin(frame.angle)
  const at = (lx: number, ly: number): [number, number] => [
    frame.x + lx * ca - ly * sa,
    frame.y + lx * sa + ly * ca,
  ]
  const a = at(-spec[0], 0)
  const c = at(0, spec[1])
  const b = at(spec[0], 0)
  return (
    'M' + a[0].toFixed(2) + ' ' + a[1].toFixed(2) +
    ' Q' + c[0].toFixed(2) + ' ' + c[1].toFixed(2) +
    ' ' + b[0].toFixed(2) + ' ' + b[1].toFixed(2)
  )
}

/** Face-space transform placing the face inside a silhouette. */
export const anchorTransform = (a: { x: number; y: number; scale: number }) =>
  `translate(${a.x} ${a.y}) scale(${a.scale}) translate(${-FACE_CENTRE[0]} ${-FACE_CENTRE[1]})`

/** Overshooting ease, so a pop-in lands with a little life instead of stopping dead. */
const easeOutBack = (t: number) => {
  const c = 1.7
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t))

/**
 * Builds the body's transform for this frame.
 *
 * `elapsed` is time since the state was entered, which is what one-shot entrances need;
 * loops read it too so every mascot on a page doesn't pulse in lockstep.
 */
export function bodyTransform(motion: BodyMotion, elapsed: number, strength: number): string {
  if (strength <= 0) return ''
  const centre = FACE_BOX / 2
  const ground = FACE_BOX
  const wave = (period: number, phase = 0) => Math.sin((elapsed / period) * Math.PI * 2 + phase)

  let dx = 0
  let dy = 0
  let rotation = motion.tilt ? motion.tilt * strength : 0
  let scale = 1
  let sx = 1
  let sy = 1

  if (motion.bob) {
    const [amplitude, period] = motion.bob
    const p = wave(period)
    dy -= amplitude * strength * p
    if (motion.squash) {
      // Squash at the bottom of the arc, stretch at the top. Volume roughly conserved.
      const amount = motion.squash * strength * Math.max(0, -p)
      sy = 1 - amount * 0.5
      sx = 1 + amount * 0.5
    }
  }
  if (motion.circle) {
    const [radius, period] = motion.circle
    dx += radius * strength * wave(period)
    dy += radius * strength * wave(period, Math.PI / 2)
  }
  if (motion.sway) {
    const [degrees, period] = motion.sway
    rotation += degrees * strength * wave(period)
  }
  if (motion.pulse) {
    const [fraction, period] = motion.pulse
    scale *= 1 + fraction * strength * wave(period)
  }
  if (motion.jitter) {
    const [amplitude, period] = motion.jitter
    // Two incommensurate waves read as nervous rather than metronomic.
    dx += amplitude * strength * wave(period)
    dy += amplitude * strength * wave(period * 0.63, 1.1)
  }
  if (motion.enter) {
    const [from, duration] = motion.enter
    const t = elapsed / duration
    scale *= t >= 1 ? 1 : from + (1 - from) * easeOutBack(Math.max(t, 0))
  }
  if (motion.settle !== undefined) {
    const t = Math.min(Math.max(elapsed / SETTLE_MS, 0), 1)
    scale *= 1 + (motion.settle - 1) * easeInOut(t) * strength
  }

  const parts: string[] = []
  if (dx || dy) parts.push(`translate(${dx.toFixed(2)} ${dy.toFixed(2)})`)
  if (rotation) parts.push(`rotate(${rotation.toFixed(2)} ${centre} ${centre})`)
  if (scale !== 1) {
    parts.push(`translate(${centre} ${centre}) scale(${scale.toFixed(4)}) translate(${-centre} ${-centre})`)
  }
  if (sx !== 1 || sy !== 1) {
    // Squash pivots on the ground, not the middle — otherwise it floats instead of landing.
    parts.push(`translate(${centre} ${ground}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-centre} ${-ground})`)
  }
  return parts.join(' ')
}

/* --------------------------------------------------------------- component */

export interface CursorAvatarProps {
  state?: CursorState
  /** Pin a specific expression. Stops the state's own cycling. */
  expression?: number
  size?: number | string
  /** Eye offset, each axis -1…1. */
  gaze?: { x?: number; y?: number }
  /** Head turn in degrees; the eyes wrap around the implied sphere. */
  turn?: number
  /** How much of each expression's own look-direction to apply. 0 = always forward. */
  lookAround?: number
  flip?: boolean
  spring?: number
  eyeScale?: number
  showMouth?: boolean
  mouthStroke?: number
  /** How strongly the body itself moves. 0 holds it perfectly still, 1 is full motion. */
  motion?: number
  /** Confetti and motion ribbons. */
  effects?: boolean
  /** Let states like alerting replace the mascot with a symbol. */
  glyphs?: boolean
  autoBlink?: boolean
  autoExpression?: boolean
  paused?: boolean
  /** Silhouette to wear. Defaults to the baked-in mascot silhouette. */
  silhouette?: CursorSilhouette
  /**
   * Body texture drawn behind the face, clipped to the silhouette. Null draws
   * none (the flat gradient shows through). The pattern is deterministic from
   * `seed`, so a bot keeps its texture across screens and renames.
   */
  pattern?: { seed: string; colors: string[]; variant: BoringVariant } | null
  /** How opaque the texture is over the gradient; defaults to 1 when the face is hidden. */
  patternOpacity?: number
  /**
   * Shape of the eyes. "dots" is the simple rounded pair; "rings" is the
   * expressive 48-point engine. Both follow the same face anchor, so either
   * sits centred on the silhouette.
   */
  eyeStyle?: "dots" | "rings"
  /**
   * Draw the eyes and mouth over the texture. Off leaves the pattern as the
   * inner content — the shapes and body motion still animate.
   */
  face?: boolean
  gradient?: [string, string, string]
  eyeColor?: string
  title?: string | null
  className?: string
  style?: React.CSSProperties
}

export interface CursorAvatarHandle {
  blink: () => void
  spin: (durationMs?: number) => void
  setExpression: (index: number) => void
}

export const CursorAvatar = React.forwardRef<CursorAvatarHandle, CursorAvatarProps>(
  function CursorAvatar(
    {
      state = 'idle',
      expression,
      size = 160,
      gaze,
      turn = 0,
      lookAround = 0.5,
      flip = false,
      spring = 7,
      eyeScale = 1,
      showMouth = true,
      mouthStroke = MOUTH_STROKE,
      motion,
      effects = true,
      glyphs = true,
      autoBlink = true,
      autoExpression = true,
      paused = false,
      silhouette = DEFAULT_SILHOUETTE,
      pattern = null,
      patternOpacity,
      face = true,
      eyeStyle = "dots",
      gradient = DEFAULT_GRADIENT,
      eyeColor = "#ffffff",
      title,
      className,
      style,
    },
    ref
  ) {
    const reactId = useId()
    const uid = useMemo(() => 'mascot' + reactId.replace(/[^a-zA-Z0-9]/g, ''), [reactId])
    const eye0 = useRef<SVGPathElement | null>(null)
    const eye1 = useRef<SVGPathElement | null>(null)
    const mouth = useRef<SVGPathElement | null>(null)
    const bodyGroup = useRef<SVGGElement | null>(null)
    const bodyContent = useRef<SVGGElement | null>(null)
    const trailLayer = useRef<SVGGElement | null>(null)
    const confettiLayer = useRef<SVGGElement | null>(null)
    const glyphLayer = useRef<SVGGElement | null>(null)
    const patternLayer = useRef<SVGGElement | null>(null)
    const patternSeed = pattern?.seed
    const patternColors = pattern?.colors.join(',')
    const patternVariant = pattern?.variant
    const patternMarkup = useMemo(() => {
      if (!patternSeed || !patternColors || !patternVariant) return null
      return boringPattern({
        seed: patternSeed,
        colors: patternColors.split(','),
        variant: patternVariant,
      })
    }, [patternSeed, patternColors, patternVariant])

    // Respect the OS setting unless the caller states a preference explicitly.
    const prefersReducedMotion = useMemo(
      () => globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      []
    )
    const motionStrength = motion ?? (prefersReducedMotion ? 0 : 1)
    const lastState: CursorState = state

    // Frame-loop state lives in a ref so prop changes never restart a morph.
    const engine = useRef({
      current: clone(EXPRESSIONS[0]),
      target: EXPRESSIONS[0],
      currentMouth: MOUTHS[0].slice(),
      targetMouth: MOUTHS[0],
      currentGaze: [...GAZE[0]],
      targetGaze: [...GAZE[0]],
      expression: 0,
      morph: 1,
      velocity: 0,
      blinkStart: noTimestamp(),
      spinStart: noTimestamp(),
      spinDuration: 900,
      last: 0,
      stateStart: 0,
      lastState,
      lastBodyTransform: '',
      lastPatternTransform: '',
      // what the parked loop last painted; '' means "never" so a mascot that
      // mounts paused still gets its one resting-face paint
      pausedPaint: '',
      props: {
        state,
        expression,
        gaze,
        turn,
        spring,
        eyeScale,
        eyeStyle,
        paused,
        lookAround,
        motionStrength,
        effects,
        glyphs,
      },
    })
    engine.current.props = {
      state,
      expression,
      gaze,
      turn,
      spring,
      eyeScale,
      eyeStyle,
      paused,
      lookAround,
      motionStrength,
      effects,
      glyphs,
    }

    const selectExpression = (index: number) => {
      const e = engine.current
      const i = ((index % EXPRESSION_COUNT) + EXPRESSION_COUNT) % EXPRESSION_COUNT
      if (i === e.expression && e.morph >= 1) return
      e.current = displayed(e)
      e.currentMouth = displayedMouth(e)
      e.currentGaze = displayedGaze(e)
      e.target = EXPRESSIONS[i]
      e.targetMouth = MOUTHS[i]
      e.targetGaze = GAZE[i]
      e.expression = i
      e.morph = 0
      e.velocity = 0
    }

    React.useImperativeHandle(
      ref,
      () => ({
        blink: () => {
          engine.current.blinkStart = performance.now()
        },
        spin: (durationMs = 900) => {
          engine.current.spinDuration = durationMs
          engine.current.spinStart = performance.now()
        },
        setExpression: selectExpression,
      }),
      []
    )

    useEffect(() => {
      selectExpression(expression ?? POOLS[state][0])
    }, [state, expression])

    useEffect(() => {
      if (!autoExpression || expression !== undefined || paused) return
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        const [lo, hi] = EXPR_CADENCE[state]
        timer = setTimeout(() => {
          const pool = POOLS[state]
          const alternatives = pool.filter(x => x !== engine.current.expression)
          selectExpression(
            alternatives.length
              ? alternatives[Math.floor(Math.random() * alternatives.length)]
              : pool[0]
          )
          tick()
        }, lo + Math.random() * (hi - lo))
      }
      tick()
      return () => clearTimeout(timer)
    }, [state, autoExpression, expression, paused])

    useEffect(() => {
      const cadence = BLINK[state]
      if (!autoBlink || !cadence || paused) return
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        timer = setTimeout(() => {
          engine.current.blinkStart = performance.now()
          tick()
        }, cadence[0] + Math.random() * (cadence[1] - cadence[0]))
      }
      tick()
      return () => clearTimeout(timer)
    }, [state, autoBlink, paused])

    useEffect(() => {
      let frame = 0
      let wake: ReturnType<typeof setTimeout> | undefined
      engine.current.last = performance.now()

      const draw = (e: typeof engine.current, now: number, spinTurn: number) => {
        const p = e.props
        // Re-apply a fraction of this expression's own look-direction.
        const g = displayedGaze(e)
        const look = p.lookAround ?? 0.35
        const ox = g[0] * look
        const oy = g[1] * look
        const rings = displayed(e).map(ring =>
          ring.map((pt): [number, number] => [pt[0] + ox, pt[1] + oy])
        )
        const gx = clamp(p.gaze?.x ?? 0, -1, 1) * GAZE_TRAVEL.x
        const gy = clamp(p.gaze?.y ?? 0, -1, 1) * GAZE_TRAVEL.y
        const radians = (((p.turn ?? 0) + spinTurn) * Math.PI) / 180
        const base = p.eyeScale ?? 1
        const blink = blinkScale(e, now)

        rings.forEach((ring, index) => {
          const el = index === 0 ? eye0.current : eye1.current
          if (!el) return
          const c = ringCentre(ring)
          const baseLongitude = Math.asin(clamp((c[0] - SPHERE_C) / SPHERE_R, -1, 1))
          const longitude = baseLongitude + radians
          const depth = Math.cos(longitude)
          const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02)
          el.setAttribute(
            'd',
            (p.eyeStyle ?? 'dots') === 'dots'
              ? dotPath(c[0], c[1], DOT_EYE.rx, DOT_EYE.ry)
              : toPath(ring)
          )
          el.setAttribute(
            'transform',
            `translate(${(SPHERE_C + SPHERE_R * Math.sin(longitude) + gx).toFixed(2)} ${(
              c[1] + gy
            ).toFixed(2)}) scale(${clamp(perspective * base, 0.02, 2.4).toFixed(4)} ${clamp(
              blink * base,
              0.02,
              2.4
            ).toFixed(4)}) translate(${(-c[0]).toFixed(2)} ${(-c[1]).toFixed(2)})`
          )
          el.style.opacity = depth > 0.02 ? '1' : '0'
        })

        // Mouth: same sphere projection as the eyes, but blinking never touches it.
        const mouthEl = mouth.current
        if (mouthEl) {
          const baseMouth = displayedMouth(e)
          const spec = [
            baseMouth[0] * MOUTH_SCALE,
            baseMouth[1] * MOUTH_SCALE,
            baseMouth[2],
            baseMouth[3],
          ]
          const frameGeom = mouthFrame(rings, spec)
          const baseLongitude = Math.asin(clamp((frameGeom.x - SPHERE_C) / SPHERE_R, -1, 1))
          const longitude = baseLongitude + radians
          const depth = Math.cos(longitude)
          const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02)
          mouthEl.setAttribute('d', mouthPath(frameGeom, spec))
          mouthEl.setAttribute(
            'transform',
            `translate(${(SPHERE_C + SPHERE_R * Math.sin(longitude) + gx).toFixed(2)} ${(
              frameGeom.y + gy
            ).toFixed(2)}) scale(${clamp(perspective, 0.02, 2.4).toFixed(4)} 1) translate(${(
              -frameGeom.x
            ).toFixed(2)} ${(-frameGeom.y).toFixed(2)})`
          )
          mouthEl.style.opacity = depth > 0.02 ? '1' : '0'
        }

        // The body texture drifts as a secondary action: it lags the body rather than
        // leading it. Idle holds perfectly still so dozens of sidebar avatars don't
        // repaint forever; only a live state spends the frames.
        const patternEl = patternLayer.current
        if (patternEl) {
          const elapsed = now - e.stateStart
          const strength = p.motionStrength ?? 1
          let transform = ''
          if (strength > 0) {
            if (p.state === 'celebrate') {
              transform = `rotate(${((elapsed / 1000) * 30).toFixed(2)} ${SPHERE_C} ${SPHERE_C})`
            } else if (
              p.state === 'working' ||
              p.state === 'sending'
            ) {
              const s = 1 + Math.sin((elapsed / 1600) * Math.PI * 2) * 0.03 * strength
              transform = `translate(${SPHERE_C} ${SPHERE_C}) scale(${s.toFixed(4)}) translate(${-SPHERE_C} ${-SPHERE_C})`
            } else if (
              p.state === 'thinking' ||
              p.state === 'searching' ||
              p.state === 'curious' ||
              p.state === 'loading'
            ) {
              const deg = Math.sin((elapsed / 4000) * Math.PI * 2) * 6 * strength
              transform = `rotate(${deg.toFixed(2)} ${SPHERE_C} ${SPHERE_C})`
            }
          }
          if (transform !== e.lastPatternTransform) {
            e.lastPatternTransform = transform
            if (transform) patternEl.setAttribute('transform', transform)
            else patternEl.removeAttribute('transform')
          }
        }

        // The body. One-shot entrances need time since the state began, so track that here
        // rather than in an effect — the loop already has the clock.
        const bodyEl = bodyGroup.current
        if (bodyEl) {
          if (p.state !== e.lastState) {
            e.lastState = p.state
            e.stateStart = now
          }
          const transform = bodyTransform(
            MOTION[p.state] ?? {},
            now - e.stateStart,
            p.motionStrength ?? 1
          )
          if (transform !== e.lastBodyTransform) {
            e.lastBodyTransform = transform
            if (transform) bodyEl.setAttribute('transform', transform)
            else bodyEl.removeAttribute('transform')
          }
        }

        updateEffects({
          trails: trailLayer.current,
          confetti: confettiLayer.current,
          glyph: glyphLayer.current,
          bodyContent: bodyContent.current,
          state: p.state,
          elapsed: now - e.stateStart,
          strength: p.motionStrength ?? 1,
          paint: paintRef.current,
          showEffects: p.effects !== false,
          showGlyphs: p.glyphs !== false,
        })
      }

      const step = (now: number) => {
        const e = engine.current
        const p = e.props
        // A paused mascot must not wake at display rate: re-arming BEFORE the
        // pause check once had N idle sidebar faces ticking at 60fps forever.
        // While paused, poll for unpause at 4Hz — but the resting face must
        // still be PAINTED: the SVG layers hold no expression until the first
        // draw, so a mascot that mounts paused would otherwise stay blank.
        // One draw per change of what the still face shows, then park.
        if (p.paused) {
          e.last = now
          const still = `${p.state}|${p.expression ?? ''}|${paintRef.current}`
          if (e.pausedPaint !== still) {
            e.pausedPaint = still
            draw(e, now, 0)
          }
          wake = setTimeout(() => {
            frame = requestAnimationFrame(step)
          }, 250)
          return
        }
        e.pausedPaint = ''
        frame = requestAnimationFrame(step)
        const dt = Math.min((now - e.last) / 1000, 0.1)
        e.last = now

        const f = p.spring ?? 7
        e.velocity += (-2 * f * e.velocity - f * f * (e.morph - 1)) * dt
        e.morph += e.velocity * dt
        if (!Number.isFinite(e.morph)) {
          e.morph = 1
          e.velocity = 0
        }

        let spinTurn = 0
        if (e.spinStart !== null) {
          const tt = (now - e.spinStart) / e.spinDuration
          if (tt >= 1) e.spinStart = null
          else spinTurn = 360 * tt
        }

        draw(e, now, spinTurn)
      }

      frame = requestAnimationFrame(step)
      return () => {
        cancelAnimationFrame(frame)
        if (wake !== undefined) clearTimeout(wake)
      }
    }, [])

    const paint = `url(#${uid}-grad)`
    const paintRef = useRef(paint)
    paintRef.current = paint
    // With the face off, the texture is the content, so it fills the body
    // rather than tinting it. With the face on it must stay quiet enough for
    // white eyes to read on top.
    const textureOpacity = patternOpacity ?? (face ? 0.42 : 1)

    const dimension = size.constructor === Number ? `${size}px` : size
    const label = title === undefined ? `${silhouette.name} mascot` : title
    const body = silhouette.body.replace(/\{\{GRADIENT\}\}/g, `url(#${uid}-grad)`)

    return (
      <svg
        viewBox={VIEW_BOX}
        width={dimension}
        height={dimension}
        className={className}
        style={style}
        role={label ? 'img' : undefined}
        aria-label={label ?? undefined}
        aria-hidden={label ? undefined : true}
      >
        <defs>
          <linearGradient id={`${uid}-grad`} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gradient[0]} />
            <stop offset="55%" stopColor={gradient[1]} />
            <stop offset="100%" stopColor={gradient[2]} />
          </linearGradient>
          {/* The fit goes on the clipPath itself: a <g> inside one is ignored by browsers,
              which is also why silhouette.clip is pre-flattened to bare shapes. */}
          <clipPath
            id={`${uid}-clip`}
            transform={silhouette.fit || undefined}
            dangerouslySetInnerHTML={{ __html: silhouette.clip }}
          />
        </defs>
        <g transform={flip ? `translate(${FACE_BOX} 0) scale(-1 1)` : undefined}>
          {/* Ribbons sit behind the mascot, confetti in front of it. */}
          <g ref={trailLayer} />
          {/* Body and face move together — the face is painted on the body, not floating
              in front of it, so a squash or a tilt has to carry both. The glyph rides the
              same motion but is not faded with them, since it replaces them. */}
          <g ref={bodyGroup}>
          <g ref={bodyContent}>
          <g transform={silhouette.fit || undefined} dangerouslySetInnerHTML={{ __html: body }} />
          <g clipPath={`url(#${uid}-clip)`}>
            {patternMarkup && (
              <g ref={patternLayer}>
                <g
                  style={{ opacity: textureOpacity }}
                  transform={`translate(${SPHERE_C} ${SPHERE_C}) scale(${(
                    (FACE_BOX * 1.15) /
                    patternMarkup.size
                  ).toFixed(4)}) translate(${-patternMarkup.size / 2} ${-patternMarkup.size / 2})`}
                  dangerouslySetInnerHTML={{ __html: patternMarkup.markup }}
                />
              </g>
            )}
            {face && (
              <g transform={anchorTransform(silhouette.anchor)}>
                <path ref={eye0} fill={eyeColor} />
                <path ref={eye1} fill={eyeColor} />
                {showMouth && (
                  <path
                    ref={mouth}
                    fill="none"
                    stroke={eyeColor}
                    strokeWidth={mouthStroke}
                    strokeLinecap="round"
                  />
                )}
              </g>
            )}
          </g>
          </g>
          <g ref={glyphLayer} style={{ opacity: 0 }} />
          </g>
          <g ref={confettiLayer} />
        </g>
      </svg>
    )
  }
)

/* ----------------------------------------------------------------- helpers */

function displayed(e: { current: Ring[]; target: Ring[]; morph: number }): Ring[] {
  const m = clamp(e.morph, 0, 1)
  return e.current.map((ring, eye) =>
    ring.map((p, i): [number, number] => [
      p[0] + (e.target[eye][i][0] - p[0]) * m,
      p[1] + (e.target[eye][i][1] - p[1]) * m,
    ])
  )
}

function displayedMouth(e: { currentMouth: number[]; targetMouth: number[]; morph: number }) {
  const m = clamp(e.morph, 0, 1)
  return e.currentMouth.map((v, i) => v + (e.targetMouth[i] - v) * m)
}

function displayedGaze(e: { currentGaze: number[]; targetGaze: number[]; morph: number }) {
  const m = clamp(e.morph, 0, 1)
  return e.currentGaze.map((v, i) => v + (e.targetGaze[i] - v) * m)
}

function blinkScale(e: { blinkStart: number | null }, now: number) {
  if (e.blinkStart === null) return 1
  const t = (now - e.blinkStart) / 320
  if (t >= 1) {
    e.blinkStart = null
    return 1
  }
  // Fast close, slower open.
  return Math.max(t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58, 0.04)
}

export default CursorAvatar
