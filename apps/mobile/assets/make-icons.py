"""
Generate the EVE app icon set from EVElogo1.png.

Run from anywhere:  python3 apps/mobile/assets/make-icons.py
Requires Pillow.    pip install Pillow

The source is 574x448 with alpha but the mark only occupies 382x309 of it, so
it is trimmed to its true bounding box before any scaling — otherwise the
transparent margin baked into the export throws off every "mark occupies N% of
the canvas" calculation, and Android's adaptive-icon safe zone in particular
has no margin to spare.

See README.md in this directory for the per-file coverage rationale and the
resolution caveat.
"""

import os
from PIL import Image

ASSETS = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ASSETS, "EVElogo1.png")

LAVENDER = (243, 239, 250, 255)  # palette.background, light scheme

src = Image.open(SRC).convert("RGBA")
bbox = src.getbbox()
mark = src.crop(bbox)
print(f"source {src.size}  ->  trimmed {mark.size}")


def render(size, coverage, bg, name):
    """Center the mark on a `size` square, scaled so its longest edge is
    `coverage` of the canvas. `bg` of None leaves the canvas transparent."""
    canvas = Image.new("RGBA", (size, size), bg or (0, 0, 0, 0))
    target = int(size * coverage)
    w, h = mark.size
    scale = target / max(w, h)
    new = (max(1, round(w * scale)), max(1, round(h * scale)))
    resized = mark.resize(new, Image.LANCZOS)
    canvas.paste(resized, ((size - new[0]) // 2, (size - new[1]) // 2), resized)

    out = os.path.join(ASSETS, name)
    if bg is not None:
        # iOS rejects an alpha channel on the home-screen icon.
        canvas.convert("RGB").save(out, "PNG", optimize=True)
    else:
        canvas.save(out, "PNG", optimize=True)
    print(f"{name:24} {size}x{size}  mark {new[0]}x{new[1]}  upscale {scale:.2f}x")


# In-app mark. Rendered at ~62pt (186px at 3x), so this is downsampled in
# practice and the nominal upscale here costs nothing visible.
render(1024, 0.88, None, "logo.png")

# iOS home screen: opaque, and the OS applies its own corner mask.
render(1024, 0.62, LAVENDER, "icon.png")

# Android foreground. Launchers crop the outer ~18% per edge, so the mark is
# held inside the middle 60% — under the 66% safe zone with room to spare.
render(1024, 0.60, None, "adaptive-icon.png")

# Splash. Expo scales this down against the backgroundColor set in app.json.
render(1024, 0.50, None, "splash.png")
