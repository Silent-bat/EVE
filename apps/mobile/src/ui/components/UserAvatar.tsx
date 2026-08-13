/**
 * The user's own avatar — the counterpart to `AIAvatar`.
 *
 * Three tiers, in order: the Google profile photo, the initials from the name
 * or address, and finally a person glyph. The fallbacks matter because a photo
 * is the one thing here that can fail at runtime — Google's CDN URLs expire,
 * and a Workspace account may never have had one. `onError` demotes to initials
 * rather than leaving a broken image in the header.
 *
 * Kept visually distinct from AIAvatar: EVE is a purple gradient with a
 * sparkle, the user is a photo or a tinted circle. The header shows this one so
 * that tapping it plainly means "me and my settings", not "ask EVE".
 */
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { radius } from "../theme";
import { useTheme } from "../ThemeContext";

export type UserAvatarSize = "sm" | "md" | "lg";

const DIMENSIONS: Record<UserAvatarSize, { box: number; glyph: number; text: number }> = {
  sm: { box: 32, glyph: 16, text: 13 },
  md: { box: 44, glyph: 21, text: 17 },
  lg: { box: 52, glyph: 25, text: 20 },
};

export function UserAvatar({
  photoURL,
  name,
  email,
  size = "md",
  style,
}: {
  photoURL?: string | null;
  name?: string | null;
  email?: string | null;
  size?: UserAvatarSize;
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  const { box, glyph, text } = DIMENSIONS[size];
  const [failed, setFailed] = useState(false);

  // A new URL deserves a fresh attempt — otherwise switching accounts inherits
  // the previous one's failure and never shows the new photo.
  useEffect(() => setFailed(false), [photoURL]);

  const letters = initials(name, email);
  const showPhoto = Boolean(photoURL) && !failed;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={name || email || "Your profile"}
      style={[
        styles.base,
        {
          width: box,
          height: box,
          borderRadius: radius.pill,
          backgroundColor: palette.ambientTint,
        },
        style,
      ]}
    >
      {showPhoto ? (
        <Image
          source={{ uri: photoURL ?? undefined }}
          style={styles.photo}
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
        />
      ) : letters ? (
        <Text style={[styles.letters, { fontSize: text, color: palette.ambient }]}>{letters}</Text>
      ) : (
        <Ionicons name="person" size={glyph} color={palette.ambient} />
      )}
    </View>
  );
}

/**
 * Up to two initials. Prefers the display name ("Ada Lovelace" → "AL") and
 * falls back to the first letter of the address. Returns "" when there is
 * nothing to work with, which is the caller's cue to draw the glyph instead.
 */
function initials(name?: string | null, email?: string | null): string {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const first = words[0]?.[0] ?? "";
    const last = words[words.length - 1]?.[0] ?? "";
    return (first + last).toUpperCase();
  }
  if (words.length === 1) return (words[0]?.[0] ?? "").toUpperCase();
  const handle = (email || "").trim();
  return handle ? (handle[0] ?? "").toUpperCase() : "";
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  photo: { width: "100%", height: "100%" },
  letters: { fontWeight: "800" },
});
