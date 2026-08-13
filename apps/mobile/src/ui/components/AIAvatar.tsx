/**
 * EVE's identity mark: a sparkle in a purple circle.
 *
 * Used wherever EVE is the author of something — the home header, chat replies,
 * suggestion cards. It is deliberately the same glyph and the same purple every
 * time, so a user learns to read "purple sparkle" as "this came from EVE" and
 * never has to wonder whether a card is her voice or their own mail.
 */
import { Ionicons } from "@expo/vector-icons";
import { View, type StyleProp, type ViewStyle } from "react-native";

import { SoftGradient } from "../gradient";
import { radius } from "../theme";
import { useTheme } from "../ThemeContext";

export type AIAvatarSize = "sm" | "md" | "lg";

const DIMENSIONS: Record<AIAvatarSize, { box: number; glyph: number }> = {
  sm: { box: 28, glyph: 14 },
  md: { box: 40, glyph: 19 },
  lg: { box: 56, glyph: 26 },
};

export function AIAvatar({
  size = "md",
  /** Flat purple instead of the gradient. For dense lists. */
  flat = false,
  style,
}: {
  size?: AIAvatarSize;
  flat?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  const { box, glyph } = DIMENSIONS[size];

  return (
    <View
      // One label for the whole mark: a screen reader should hear "EVE", not a
      // description of a sparkle.
      accessible
      accessibilityRole="image"
      accessibilityLabel="EVE"
      style={[
        {
          width: box,
          height: box,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          backgroundColor: palette.ambient,
        },
        style,
      ]}
    >
      {flat ? null : (
        <SoftGradient
          colors={[palette.ambient, palette.ambientDeep]}
          direction="diagonal"
          bands={10}
        />
      )}
      <Ionicons name="sparkles" size={glyph} color={palette.textInverse} />
    </View>
  );
}
