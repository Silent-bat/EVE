/**
 * The EVE component system.
 *
 * Screens import from here rather than reaching into individual files, so the
 * internal layout of this folder can change without touching every screen.
 * Lower-level pieces (Card, Chip, SettingsRow…) still live in `../primitives`.
 */
export { AIAvatar, type AIAvatarSize } from "./AIAvatar";
export { BottomNav, BOTTOM_NAV_CLEARANCE, type NavTab } from "./BottomNav";
export { ChatBubble, VoiceMessage, type ChatAuthor } from "./ChatBubble";
export { GradientButton } from "./GradientButton";
export { ParticleField, type FieldState } from "./ParticleField";
export { Section } from "./Section";
export { TopNav, RoundButton } from "./TopNav";
export { UserAvatar, type UserAvatarSize } from "./UserAvatar";
export { Waveform } from "./Waveform";

export { CardShell } from "./cards/CardShell";
export { CalendarCard, NextUpCard } from "./cards/CalendarCard";
export {
  AttentionCard,
  CRITICAL_SCORE,
  countHighPriority,
  EmailCard,
  emailUrgencyLabel,
  emailUrgencyTone,
  HIGH_SCORE,
} from "./cards/EmailCard";
export { MemoryCard, MemorySummary, MEMORY_FIELDS, type MemoryField } from "./cards/MemoryCard";
export { SuggestionCard } from "./cards/SuggestionCard";
export { TaskCard } from "./cards/TaskCard";

export {
  EmptyState,
  ErrorState,
  LoadingState,
  SkeletonCard,
  describeError,
  isNotFound,
} from "./states";
