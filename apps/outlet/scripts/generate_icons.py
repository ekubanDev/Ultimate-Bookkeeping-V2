"""Regenerate the PWA icons in apps/outlet/public/.

The icons are committed as PNGs because the build just copies them, but they
are GENERATED, not drawn by hand — this script is the source. If the brand
colours or the wordmark change, edit here and re-run rather than editing the
PNGs, otherwise the two drift and nobody can tell which was intended.

    python apps/outlet/scripts/generate_icons.py

Colours come from the web manifest in vite.config.js (`theme_color` /
`background_color`). They are duplicated here as constants because this script
cannot read the JS config, so THIS IS A KNOWN "same value in two places" —
the assert below fails the run if vite.config.js no longer agrees, which is
the cheapest available guard.

MASKABLE SAFE ZONE: Android may crop a `purpose: "maskable"` icon to a circle
whose diameter is 80% of the image. Anything outside that circle can be cut
off, so the maskable variant draws the wordmark smaller and lets the
background bleed to the edges. The two non-maskable icons are not cropped
that way and can use the full square.
"""
from __future__ import annotations

import pathlib
import re
import sys

from PIL import Image, ImageDraw, ImageFont

NAVY = "#1e1b4b"
AMBER = "#f4b73f"

HERE = pathlib.Path(__file__).resolve().parent
PUBLIC = HERE.parent / "public"
VITE_CONFIG = HERE.parent / "vite.config.js"

# Bold face inside macOS's Helvetica collection. Index 1 is Helvetica Bold.
FONT_CANDIDATES = [
    ("/System/Library/Fonts/HelveticaNeue.ttc", 1),
    ("/System/Library/Fonts/Helvetica.ttc", 1),
    ("/Library/Fonts/Arial Unicode.ttf", 0),
]


def _assert_colours_still_match_the_manifest() -> None:
    """Fail loudly if vite.config.js's colours drifted from this script."""
    if not VITE_CONFIG.exists():
        return
    text = VITE_CONFIG.read_text()
    found = set(re.findall(r'(?:theme_color|background_color):\s*"(#[0-9a-fA-F]{6})"', text))
    if found and found != {NAVY}:
        sys.exit(
            f"vite.config.js declares {sorted(found)} but this script draws {NAVY}.\n"
            "Update NAVY here (or the manifest) so the icon matches the splash screen."
        )


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    for path, index in FONT_CANDIDATES:
        if pathlib.Path(path).exists():
            try:
                return ImageFont.truetype(path, size, index=index)
            except OSError:
                continue
    sys.exit("No bold font found — edit FONT_CANDIDATES for this machine.")


def _draw(size: int, *, maskable: bool) -> Image.Image:
    img = Image.new("RGB", (size, size), NAVY)
    draw = ImageDraw.Draw(img)

    # Wordmark height as a fraction of the canvas. Smaller when maskable so the
    # glyphs stay inside the 80% circle Android may crop to.
    fraction = 0.30 if maskable else 0.40
    font = _load_font(int(size * fraction))

    text = "UB"
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    glyph_w, glyph_h = right - left, bottom - top

    rule_h = max(2, int(size * 0.026))
    gap = size * 0.075
    block_h = glyph_h + gap + rule_h  # wordmark + gap + ledger rule

    # Centre the whole block, then derive the text anchor from it. textbbox is
    # measured from the anchor, so the anchor is NOT the visual top — subtract
    # `top` (and `left`) to convert. Getting this wrong is what made the rule
    # sit on top of the letters the first time.
    block_top = (size - block_h) / 2
    x = (size - glyph_w) / 2 - left
    y = block_top - top
    draw.text((x, y), text, font=font, fill=AMBER)

    # A ledger rule under the wordmark — the one bit of character, and it still
    # reads as a deliberate mark rather than a default at 192px. Positioned
    # from the glyphs' ACTUAL bottom edge (y + bottom), not from the anchor.
    rule_w = glyph_w * 0.96
    rule_y = y + bottom + gap
    draw.rounded_rectangle(
        [(size - rule_w) / 2, rule_y, (size + rule_w) / 2, rule_y + rule_h],
        radius=rule_h / 2,
        fill=AMBER,
    )
    return img


def main() -> None:
    _assert_colours_still_match_the_manifest()
    PUBLIC.mkdir(parents=True, exist_ok=True)
    outputs = [
        (PUBLIC / "pwa-192.png", 192, False),
        (PUBLIC / "pwa-512.png", 512, False),
        (PUBLIC / "pwa-maskable-512.png", 512, True),
    ]
    for path, size, maskable in outputs:
        _draw(size, maskable=maskable).save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(PUBLIC.parent.parent.parent)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
