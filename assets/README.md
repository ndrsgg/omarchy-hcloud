# Icon assets

What this plugin needs, and the constraints the shell and Qt put on it.

## Where the icon is drawn, and how big

Two places, both sized from theme tokens that scale with the user's font size,
so there is no single pixel size to design for.

| `[font] base-size` | bar icon (`Style.bar.iconCanvas`) | panel hero (`Style.font.display`) |
| --- | --- | --- |
| 11 | 15 px | 22 px |
| **12** (default) | **16 px** | **24 px** |
| 13 | 17 px | 26 px |
| 14 | 19 px | 28 px |
| 16 | 21 px | 32 px |
| 18 | 24 px | 36 px |

Those are *logical* pixels. Multiply by the display scale — 1, 1.25, 1.5 or 2
under Hyprland — for physical ones. Worst realistic case is a 24 px bar icon on
a 2× display, so **48 physical pixels in the bar and 72 in the hero**.

For visual weight: the glyph icons either side of ours in the bar are drawn at
`Style.bar.iconFont`, which is 13 px of ink inside that 16 px canvas. Artwork
that fills its box edge to edge therefore reads about a quarter heavier than
its neighbours. **Leave roughly 10% padding on each side**, or hand it over
edge-to-edge and say so, and the QML will inset it.

## The file

### 1. `hetzner-symbolic.svg` — for the bar

A single-colour silhouette that the shell tints to the bar's foreground, so it
follows the theme like every other bar icon. This is the same treatment the
shell gives freedesktop `-symbolic` tray icons:
`MultiEffect { colorization: 1.0; colorizationColor: foreground }`.

- **Pure white `#ffffff` on transparent.** Not black, not grey. Colorization
  maps white exactly onto the target colour; anything darker risks coming out
  muddy depending on how the effect weights luminance.
- One colour only. No gradients, nothing that carries meaning through hue.
- Everything that should be visible is ink; everything else is transparent.

## Minimum feature sizes

This is what three failed attempts came down to. At a 15 px bar icon:

| Feature | Minimum | As a share of the box |
| --- | --- | --- |
| A stroke that is **ink** | 1.5 px | 10% |
| A gap that is **transparent** (a counter, a knockout) | 3 px | **20%** |
| Clear space between two separate shapes | 1.2 px | 8% |

A hole needs roughly twice the width of a positive stroke of the same weight.
Antialiasing eats a transparent gap from both sides while the ink around it
bleeds inward, so a 2 px counter closes up and reads as a blob.

These figures are for `QtQuick.Shapes`, which antialiases along extruded edge
geometry. **They do not apply to what this plugin now does.** Rendering the SVG
through `Image` rasterises it at four times the drawn size and area-averages it
down, and that holds the mark's own 12.4% strokes as a knockout at 16px — the
red artwork proved it before the symbolic one existed.

So the real rule is narrower: a transparent counter under 20% needs the `Image`
path, not the shape renderer. Keep the mark's own proportions.

## SVG rules

Qt renders these with QtSvg, a static SVG 1.1 / 1.2 Tiny subset. Not a browser.

**Supported:** `path`, basic shapes, `g`, transforms, presentation attributes,
an inline `style="fill:#fff"` attribute, linear and radial gradients, `use`,
simple `clipPath`.

**Not supported — will silently drop or break:**

- `<style>` blocks with CSS selectors, and CSS custom properties
- filters of any kind (`feGaussianBlur`, drop shadows, glows)
- masks and `mix-blend-mode`
- patterns
- `foreignObject`
- **`<text>`** — convert every glyph to a path, no font is guaranteed here

Also:

- Give it a **square `viewBox`**. A non-square one will be letterboxed.
- Set `width` and `height` to match the viewBox, or leave both off. Avoid
  `width="100%" height="100%"`; it makes the intrinsic size meaningless.
- No background rectangle, unless the badge itself is the background.
- Flatten transforms and groups where you can. Smaller and fewer surprises.

## If you would rather ship PNG

Workable, but one SVG covers every font size and display scale from one file,
so it is the better trade.

If PNG: **RGBA with real alpha, 256×256**, plus optionally a hand-tuned
**32×32** for the bar, where the automatic downscale of a detailed mark tends
to mush. The symbolic/full-colour split above applies unchanged — a symbolic
PNG must also be white on transparent.

## Checklist

- [ ] `hetzner-symbolic.svg` — white on transparent, one colour, ~10% padding
- [ ] Square viewBox, no filters, no masks, no `<text>`
- [ ] Nothing thinner than 10% of the box as ink, 20% as a gap

Drop them in this directory and I will wire them up and delete the hand-drawn
path currently in `HetznerIcon.qml`.
