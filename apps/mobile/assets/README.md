# Image assets

Source images for the mobile app. Expo reads the app icon and splash from here
via `app.json`, and `EveMark` renders `logo.png` on the boot, auth, and
onboarding screens.

## What's here

| File                | Size                   | Used for                                                 |
| ------------------- | ---------------------- | -------------------------------------------------------- |
| `EVElogo1.png`      | 574×448, transparent   | **Source artwork.** Everything below is derived from it. |
| `EVElogo2.svg`      | 574×448                | Source artwork as SVG — but see the caveat below.        |
| `logo.png`          | 1024×1024, transparent | The `EveMark` shown in the entry flow                    |
| `icon.png`          | 1024×1024, opaque      | Home-screen icon (iOS rejects alpha)                     |
| `adaptive-icon.png` | 1024×1024, transparent | Android foreground layer                                 |
| `splash.png`        | 1024×1024, transparent | Launch screen                                            |
| `reference.png`     | 1848×1344              | The lavender design reference the UI was built against   |

## Regenerating

The four derived PNGs are produced by a script that trims `EVElogo1.png` to the
mark's true bounding box (382×309 — the export carries a wide transparent
margin) and re-centers it at a known coverage per target. Re-run it after
replacing the source artwork; it needs Pillow.

Coverage differs per file on purpose: the launcher icon needs padding the
in-app mark does not, and Android needs more than iOS.

| File                | Mark covers | Why                                                          |
| ------------------- | ----------- | ------------------------------------------------------------ |
| `logo.png`          | 88%         | Drawn inside a 62pt purple tile, so it wants minimal padding |
| `icon.png`          | 62%         | iOS applies its own corner mask                              |
| `adaptive-icon.png` | 60%         | Inside Android's 66% safe zone with room to spare            |
| `splash.png`        | 50%         | Sits alone on a full screen                                  |

## Resolution caveat

`EVElogo1.png` trims to 382×309, so reaching 1024×1024 upscales it between
1.3× and 2.4× depending on the target. Lanczos holds the edges together and the
results are clean at real display sizes, but they are not true 1024 artwork.
**A re-export from the original vector at 1024×1024 will look sharper** and is
worth doing before a store submission.

`EVElogo2.svg` does not help here: it is a raster wrapped in SVG — one `<path>`
plus a base64 PNG blob at the same 574×448 — so it carries no more detail than
the PNG. The app also ships no `react-native-svg`, so it cannot be rendered
directly.

## Android adaptive icons clip

Android masks the foreground to a circle, squircle, or rounded square depending
on the launcher, and the outer ~18% of each edge can be cropped. `adaptive-icon.png`
holds the mark inside the middle 60% for this reason — keep that budget if you
regenerate it by hand.

## Tinting

The mark is a solid single-colour shape with an alpha channel, so `EveMark`
recolours it with `tintColor` rather than shipping a light and a dark export.
Anything that replaces `logo.png` should keep that property.
