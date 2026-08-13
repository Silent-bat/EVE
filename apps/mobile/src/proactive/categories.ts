/**
 * Per-category presentation: short label, longer description, icon, and
 * the tone used for chips and badges. Kept here so the settings UI and
 * the inbox card stay in sync — when we add a category we only edit this
 * file.
 */
import type { Ionicons } from "@expo/vector-icons";
import type { Tone } from "../ui/theme";
import type { ProactiveCategoryName, ProactiveUrgency } from "../types";

export const PROACTIVE_CATEGORY_ORDER: ProactiveCategoryName[] = [
  "urgent_email",
  "interview_prep",
  "project_checkin",
  "brainstorm_idea",
  "briefing_ready",
];

type IoniconName = keyof typeof Ionicons.glyphMap;

export type CategoryMeta = {
  name: ProactiveCategoryName;
  label: string;
  description: string;
  icon: IoniconName;
  tone: Tone;
};

export const CATEGORY_META: Record<ProactiveCategoryName, CategoryMeta> = {
  urgent_email: {
    name: "urgent_email",
    label: "Urgent email",
    description: "Ping me when an email crosses the urgency threshold mid-day.",
    icon: "flash-outline",
    tone: "warning",
  },
  interview_prep: {
    name: "interview_prep",
    label: "Interview prep",
    description: "Wake me before interviews with the context I might be missing.",
    icon: "briefcase-outline",
    tone: "info",
  },
  project_checkin: {
    name: "project_checkin",
    label: "Project check-in",
    description: "Follow up on projects I mentioned recently but haven't touched.",
    icon: "construct-outline",
    tone: "ambient",
  },
  brainstorm_idea: {
    name: "brainstorm_idea",
    label: "Brainstorm",
    description: "Surface ideas worth riffing on when I have time.",
    icon: "bulb-outline",
    tone: "ambient",
  },
  briefing_ready: {
    name: "briefing_ready",
    label: "Daily briefing",
    description: "Notify me the moment my daily briefing is ready.",
    icon: "newspaper-outline",
    tone: "success",
  },
};

export function urgencyTone(urgency: ProactiveUrgency): Tone {
  switch (urgency) {
    case "low":
      return "neutral";
    case "medium":
      return "info";
    case "high":
      return "warning";
    case "critical":
      return "danger";
  }
}

export function urgencyLabel(urgency: ProactiveUrgency): string {
  switch (urgency) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "critical":
      return "Critical";
  }
}
