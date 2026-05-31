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
