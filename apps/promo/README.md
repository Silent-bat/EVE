# EVE promotional video

Vertical 30-second Remotion composition for Reels, TikTok, and Shorts.

```bash
pnpm promo:studio
pnpm promo:render
```

The final render is written to `apps/promo/out/eve-promo-vertical.mp4`.

The render script exports the Remotion animation as an image sequence, then
uses the system FFmpeg to encode the video and mux the narration. This keeps
rendering compatible with the macOS version used by this project.
