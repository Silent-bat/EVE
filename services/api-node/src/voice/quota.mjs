/**
 * Per-user concurrent voice-session quota.
 *
 * A reservation is acquired before the HTTP upgrade and released only when the
 * client socket closes (or setup fails). Keeping this state separate from the
 * Gemini connection lifecycle prevents a successful upstream handshake from
 * accidentally freeing a still-live client slot.
 */

/**
 * @param {number} limit
 */
export function createConnectionQuota(limit) {
  const activeByUser = new Map();
  const releasedSockets = new WeakSet();

  return {
    /** @param {string} userID */
    tryAcquire(userID) {
      const active = activeByUser.get(userID) || 0;
      if (active >= limit) return false;
      activeByUser.set(userID, active + 1);
      return true;
    },

    /**
     * Release at most once for a socket. The object identity is important:
     * both setup failure and the later `close` event may race to release.
     *
     * @param {string} userID
     * @param {object} socket
     */
    release(userID, socket) {
      if (releasedSockets.has(socket)) return;
      releasedSockets.add(socket);
      const active = activeByUser.get(userID) || 0;
      if (active <= 1) activeByUser.delete(userID);
      else activeByUser.set(userID, active - 1);
    },

    /** @param {string} userID */
    count(userID) {
      return activeByUser.get(userID) || 0;
    },

    reset() {
      activeByUser.clear();
    },
  };
}
