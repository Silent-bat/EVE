/**
 * Pure date helpers — no env, no globals, no side effects.
 *
 * @param {Date} date
 * @param {number} hour
 * @param {number} minute
 * @returns {Date}
 */
export function atTime(date, hour, minute) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

/**
 * @param {Date} date
 * @param {number} minutes
 * @returns {Date}
 */
export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/**
 * `YYYY-MM-DD` in local time, used as briefing primary key.
 *
 * @param {Date} date
 * @returns {string}
 */
export function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * `HH:MM` in local time.
 *
 * @param {Date} date
 * @returns {string}
 */
export function timeKey(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Return the calendar parts for an instant in an IANA timezone.
 *
 * @param {Date} date
 * @param {string} timezone
 */
export function zonedParts(date, timezone) {
  const fallback = "UTC";
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || fallback,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: fallback,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * @param {Date} date
 * @param {string} timezone
 */
export function dayKeyInZone(date, timezone) {
  const p = zonedParts(date, timezone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * @param {Date} date
 * @param {string} timezone
 */
export function timeKeyInZone(date, timezone) {
  const p = zonedParts(date, timezone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * Convert a wall-clock date/time in `timezone` to an instant. The second pass
 * accounts for daylight-saving offset changes around midnight.
 *
 * @param {Date} date
 * @param {number} hour
 * @param {number} minute
 * @param {string} timezone
 */
export function atTimeInZone(date, hour, minute, timezone) {
  const current = zonedParts(date, timezone);
  return instantForWallTime(current.year, current.month, current.day, hour, minute, timezone);
}

/**
 * Resolve an explicit local wall-clock date/time. Kept separate from
 * `atTimeInZone` so callers can ask for the next local day without first
 * constructing a UTC probe that may still belong to the previous local day.
 *
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {string} timezone
 */
function instantForWallTime(year, month, day, hour, minute, timezone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  // Sample the nearby offsets instead of assuming the offset at `wall` also
  // applies to the requested local time. Around a DST transition those can
  // differ, and the old one-pass calculation shifted ordinary New York times
  // by five hours in the wrong direction.
  const offsets = new Set();
  const sampleWindow = 3 * 24 * 60 * 60 * 1000;
  const sampleStep = 6 * 60 * 60 * 1000;
  for (let delta = -sampleWindow; delta <= sampleWindow; delta += sampleStep) {
    const instant = new Date(wall + delta);
    const observed = zonedParts(instant, timezone);
    offsets.add(
      Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second,
      ) - instant.getTime(),
    );
  }

  const target = { year, month, day, hour, minute, second: 0 };
  const targetWall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const candidates = [...offsets].map((offset) => new Date(wall - offset));
  const exact = candidates
    .filter((candidate) => {
      const observed = zonedParts(candidate, timezone);
      return (
        observed.year === target.year &&
        observed.month === target.month &&
        observed.day === target.day &&
        observed.hour === target.hour &&
        observed.minute === target.minute
      );
    })
    .sort((a, b) => a.getTime() - b.getTime());
  // On a fall-back overlap there are two valid instants. Choosing the earlier
  // one is deterministic and matches the usual Date/Calendar convention.
  if (exact.length) return exact[0];

  // A spring-forward gap has no exact instant. Pick the nearest representable
  // wall time, preferring the later side of the gap (the convention users see
  // on clocks when 02:30 is skipped).
  const scored = candidates
    .map((candidate) => {
      const observed = zonedParts(candidate, timezone);
      const observedWall = Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second,
      );
      return { candidate, distance: Math.abs(observedWall - targetWall), observedWall };
    })
    .sort((a, b) => a.distance - b.distance || b.observedWall - a.observedWall);
  return scored[0]?.candidate || new Date(wall);
}

/**
 * Resolve an ISO calendar date (without a timezone) in the requested zone.
 * Google Calendar uses this representation for all-day events; treating it as
 * a UTC instant can move the event to the previous local day for western zones.
 *
 * @param {string} dateValue
 * @param {number} hour
 * @param {number} minute
 * @param {string} timezone
 */
export function atLocalDateInZone(dateValue, hour, minute, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ""));
  if (!match) return new Date(Number.NaN);
  return instantForWallTime(Number(match[1]), Number(match[2]), Number(match[3]), hour, minute, timezone);
}

/**
 * @param {Date} date
 * @param {string} timezone
 */
export function startOfDayInZone(date, timezone) {
  return atTimeInZone(date, 0, 0, timezone);
}

/**
 * Return the next local midnight after `date`, preserving 23/24/25-hour days.
 *
 * @param {Date} date
 * @param {string} timezone
 */
export function startOfNextDayInZone(date, timezone) {
  const current = zonedParts(date, timezone);
  const nextLocalDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  return atLocalDateInZone(
    `${String(nextLocalDay.getUTCFullYear()).padStart(4, "0")}-${String(nextLocalDay.getUTCMonth() + 1).padStart(2, "0")}-${String(nextLocalDay.getUTCDate()).padStart(2, "0")}`,
    0,
    0,
    timezone,
  );
}
