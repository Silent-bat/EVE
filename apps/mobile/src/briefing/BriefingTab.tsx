/**
 * Briefing — the whole picture, at a span you choose.
 *
 * Home answers "what needs me right now" and deliberately holds only that. This
 * tab is where the rest of it went: the full ranked inbox, the task list, and
 * the day's calendar. So it leads with the range control and ranks by importance
 * rather than by whether a decision is outstanding — a mail you already handled
 * still belongs in the record of the week.
 *
 * The pending count stays visible at the top of the inbox as a route back to
 * Home, because this page shows those mails but is not where they get decided.
 */
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { fetchTasks, setTaskDone } from "../tasks/api";
import type { Briefing, BriefingEmail, BriefingRange, Task } from "../types";
import { StatStrip } from "../home/StatStrip";
import {
  CalendarCard,
  EmailCard,
  EmptyState,
  ErrorState,
  LoadingState,
  NextUpCard,
  RoundButton,
  Section,
  TaskCard,
} from "../ui/components";
import { Segmented } from "../ui/primitives";
import { spacing } from "../ui/theme";
import { useThemedStyles, type ThemeValue } from "../ui/ThemeContext";

type Props = {
  briefing: Briefing;
  pendingCount: number;
  saving: boolean;
  range: BriefingRange;
  onChangeRange: (next: BriefingRange) => void;
  onRefresh: () => void;
  /** Jumps to Home, where the pending drafts actually get approved. */
  onOpenPending?: () => void;
  /** Opens the whole message. A row that shows a summary has to lead to one. */
  onOpenEmail?: (email: BriefingEmail) => void;
  onError: (message: string) => void;
};

const RANGE_OPTIONS: { value: BriefingRange; label: string }[] = [
  { value: "day", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const RANGE_TITLE: Record<BriefingRange, string> = {
  day: "Priority inbox",
  week: "Top weekly mail",
  month: "Top monthly mail",
};

const RANGE_NOTE: Record<BriefingRange, string> = {
  day: "Everything EVE read today, most important first.",
  week: "The last seven days, ranked by what mattered.",
  month: "A month of mail, narrowed to what stood out.",
};

export function BriefingTab({
  briefing,
  pendingCount,
  saving,
  range,
  onChangeRange,
  onRefresh,
  onOpenPending,
  onOpenEmail,
  onError,
}: Props) {
  const styles = useThemedStyles(makeStyles);
  const tasks = useTasks(onError);

  const ranked = briefing.emails.slice().sort((a, b) => b.urgencyScore - a.urgencyScore);
  const [nextUp, ...laterToday] = briefing.calendar
    .slice()
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  return (
    <View>
      <View style={styles.controls}>
        <View style={styles.flexOne}>
          <Segmented<BriefingRange>
            value={range}
            onChange={onChangeRange}
            options={RANGE_OPTIONS}
            label="Briefing range"
          />
        </View>
        <RoundButton icon="refresh" label="Refresh briefing" onPress={onRefresh} disabled={saving} />
      </View>

      <StatStrip briefing={briefing} />

      <Section
        title={RANGE_TITLE[range]}
        subtitle={RANGE_NOTE[range]}
        icon="mail-outline"
        count={ranked.length}
        // A route back rather than a refresh: the decisions live on Home, and
        // this count is the only reason someone here would want to go there.
        action={
          pendingCount > 0 && onOpenPending
            ? { label: `${pendingCount} awaiting you`, onPress: onOpenPending }
            : undefined
        }
      >
        {ranked.length === 0 ? (
          <EmptyState
            icon="mail-outline"
            title="Nothing here yet"
            body="EVE fills this in after her next sweep of your mail."
            action={{ label: "Refresh now", onPress: onRefresh }}
          />
        ) : (
          ranked.map((email) => (
            <EmailCard
              key={email.id}
              email={email}
              onPress={onOpenEmail ? () => onOpenEmail(email) : undefined}
            />
          ))
        )}
      </Section>

      <Section
        title="Tasks"
        subtitle="What EVE picked up from your mail, plus anything you added."
        icon="checkmark-circle-outline"
        count={tasks.open.length}
      >
        {tasks.error ? (
          <ErrorState error={tasks.error} subject="Tasks" onRetry={() => void tasks.reload()} />
        ) : tasks.loading ? (
          <LoadingState label="Loading tasks" cards={2} />
        ) : tasks.items.length === 0 ? (
          <EmptyState
            icon="checkmark-circle-outline"
            title="No tasks"
            body="When EVE spots something in your mail that needs doing, it lands here."
          />
        ) : (
          <>
            {tasks.open.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                busy={tasks.busyId === task.id}
                onToggle={() => void tasks.toggle(task)}
              />
            ))}
            {tasks.done.length > 0 ? (
              <>
                <Text style={styles.doneHeading}>
                  Done · {tasks.done.length}
                </Text>
                {tasks.done.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    busy={tasks.busyId === task.id}
                    onToggle={() => void tasks.toggle(task)}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </Section>

      {/* Only the day view has a calendar to show — a week of events would be a
          different screen, not a longer list. */}
      {range === "day" ? (
        <Section
          title="Calendar"
          icon="calendar-outline"
          count={briefing.calendar.length}
          hidden={briefing.calendar.length === 0}
        >
          {nextUp ? <NextUpCard event={nextUp} /> : null}
          {laterToday.map((event) => (
            <CalendarCard key={event.id} event={event} />
          ))}
        </Section>
      ) : null}
    </View>
  );
}

/**
 * The task list, with an optimistic toggle.
 *
 * `/v1/tasks` returns 404 until the backend route lands, which is why the error
 * is held rather than only reported: `ErrorState` renders a 404 as "not switched
 * on yet", and that belongs in the section instead of in the app's error banner
 * where it would look like a failure.
 */
function useTasks(onError: (message: string) => void) {
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchTasks({ limit: 50 });
      setItems(res.tasks);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = useCallback(
    async (task: Task) => {
      const done = task.status === "done";
      setBusyId(task.id);
      setItems((current) =>
        current.map((item) =>
          item.id === task.id ? { ...item, status: done ? "open" : "done" } : item,
        ),
      );
      try {
        const saved = await setTaskDone(task.id, !done);
        setItems((current) => current.map((item) => (item.id === task.id ? saved : item)));
      } catch (err) {
        setItems((current) => current.map((item) => (item.id === task.id ? task : item)));
        onError(err instanceof Error ? err.message : "Could not update that task");
      } finally {
        setBusyId(null);
      }
    },
    [onError],
  );

  return {
    items,
    open: items.filter((task) => task.status !== "done"),
    done: items.filter((task) => task.status === "done"),
    loading,
    error,
    busyId,
    reload,
    toggle,
  };
}

function makeStyles({ type }: ThemeValue) {
  return StyleSheet.create({
    flexOne: { flex: 1 },
    controls: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      marginBottom: spacing.lg,
    },
    // A divider with a word rather than a second Section: completed tasks are
    // the same list, collapsed to the bottom, not a separate topic.
    doneHeading: {
      ...type.caption,
      marginTop: spacing.sm,
      marginBottom: spacing.xs,
      paddingHorizontal: spacing.xs,
    },
  });
}
