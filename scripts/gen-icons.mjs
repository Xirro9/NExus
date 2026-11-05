// Dependency-free Tauri icon generator (SPEC-PHASE4 §4).
// Draws the AiCore mark — concentric rings + center dot, primary cyan on
// deep-navy background with alpha falloff on the outer rings — into an RGBA
// buffer at each size, then encodes PNG by hand (node:zlib deflate + CRC32;
// IHDR/IDAT/IEND chunks). No native deps, no image libraries.
//
// Usage: node scripts/gen-icons.mjs
// Outputs: src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png
// (.icns/.ico remain shipped Tauri defaults — unused on Linux, per spec §12.8.)

import { deflateSync } from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons")

// palette — matches the design tokens (index.css: --primary, --background)
const BG = [0x14, 0x14, 0x1f] // deep navy
const CYAN = [0x67, 0xe8, 0xf9] // primary cyan

const SIZES = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
]

// ---------------------------------------------------------------------------
// PNG encoding (RGBA, 8-bit, non-interlaced)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // raw scanlines: each row prefixed by filter byte 0
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// mark rendering — concentric rings + center dot (AiCore motif)

/**
 * Render at `size` px. Geometry in unit coordinates (center 0,0, radius 1):
 *   ring 1  r=0.78  alpha 0.30 (outermost, faintest)
 *   ring 2  r=0.55  alpha 0.55
 *   ring 3  r=0.33  alpha 0.90
 *   dot     r=0.13  alpha 1.0
 * Rings are strokes ~7% of the mark radius wide, soft 1px-ish edge falloff
 * via smoothstep. Background: deep navy, fully opaque, rounded corners at
 * 18% of the size (icons look right on taskbars/titlebars).
 */
function renderMark(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const unit = size * 0.42 // mark radius in px (leaves margin)
  const stroke = unit * 0.045
  const edge = Math.max(size * 0.005, 1.0) // AA width in px

  // decreasing coverage: 1 when d ≤ 0, linear falloff to 0 at d = edge
  const falloff = (d) => Math.min(1, Math.max(0, 1 - d / edge))

  const rings = [
    { r: 0.78, a: 0.28 },
    { r: 0.54, a: 0.5 },
    { r: 0.31, a: 0.85 },
  ]

  const corner = size * 0.18
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5

      // rounded-square background coverage
      const qx = Math.max(Math.abs(px - cx) - (size / 2 - corner), 0)
      const qy = Math.max(Math.abs(py - cy) - (size / 2 - corner), 0)
      const qd = Math.hypot(qx, qy)
      const bgA = falloff(qd - corner)

      // mark coverage (rings + dot, blended additively on alpha)
      const dx = px - cx
      const dy = py - cy
      const d = Math.hypot(dx, dy) / unit
      let markA = 0
      for (const ring of rings) {
        const cov = falloff(Math.abs(d - ring.r) * unit - stroke)
        markA = markA + ring.a * cov * (1 - markA)
      }
      const dotCov = falloff((d - 0.12) * unit)
      markA = markA + dotCov * (1 - markA)

      // composite cyan over navy, then over transparent
      const a = markA
      const r = BG[0] * (1 - a) + CYAN[0] * a
      const g = BG[1] * (1 - a) + CYAN[1] * a
      const b = BG[2] * (1 - a) + CYAN[2] * a
      const out = bgA
      const i = (y * size + x) * 4
      rgba[i] = Math.round(r * out)
      rgba[i + 1] = Math.round(g * out)
      rgba[i + 2] = Math.round(b * out)
      rgba[i + 3] = Math.round(255 * out)
    }
  }
  return rgba
}

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, size] of SIZES) {
  const png = encodePng(size, size, renderMark(size))
  writeFileSync(join(OUT_DIR, name), png)
  console.log(`wrote src-tauri/icons/${name} (${size}×${size}, ${png.length} bytes)`)
}
