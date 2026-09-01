import { Composition } from "remotion";
import { EvePromo } from "./EvePromo";

export const RemotionRoot = () => (
  <Composition
    id="EvePromoVertical"
    component={EvePromo}
    durationInFrames={1620}
    fps={30}
    width={1080}
    height={1920}
  />
);
