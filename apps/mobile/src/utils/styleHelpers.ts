/**
 * Tone-to-color helpers for the approval action buttons and status pills.
 * These take a palette so they resolve against the active color scheme.
 */
import type { TextStyle, ViewStyle } from "react-native";

import type { Palette } from "../ui/theme";
import type { EmailStatus } from "../types";

export type Tone = "green" | "coral" | "neutral";

export function statusStyle(palette: Palette, status: EmailStatus): ViewStyle {
  switch (status) {
    case "approved":
      return { backgroundColor: palette.successTint };
    case "rejected":
      return { backgroundColor: palette.dangerTint };
    default:
      return { backgroundColor: palette.warningTint };
  }
}

export function statusTextColor(palette: Palette, status: EmailStatus): TextStyle["color"] {
  switch (status) {
    case "approved":
      return palette.successDeep;
    case "rejected":
      return palette.danger;
    default:
      return palette.warning;
  }
}

export function actionStyle(palette: Palette, tone: Tone): ViewStyle {
  switch (tone) {
    case "green":
      return { backgroundColor: palette.successTint };
    case "coral":
      return { backgroundColor: palette.dangerTint };
    default:
      return { backgroundColor: palette.surfaceMuted };
  }
}

export function actionTextColor(palette: Palette, tone: Tone): TextStyle["color"] {
  switch (tone) {
    case "green":
      return palette.successDeep;
    case "coral":
      return palette.danger;
    default:
      return palette.text;
  }
}
