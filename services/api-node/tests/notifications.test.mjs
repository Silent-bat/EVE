import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearDeviceNotifications,
  getDeviceNotifications,
  recordDeviceNotification,
} from "../src/notifications/index.mjs";
import { state } from "../src/storage/index.mjs";

test("notification keys are scoped to the owning user", async () => {
  const firstUser = "notification-collision-first";
  const secondUser = "notification-collision-second";
  const previous = {
    first: state.deviceNotifications[firstUser],
    second: state.deviceNotifications[secondUser],
  };

  try {
    const first = await recordDeviceNotification(firstUser, {
      id: "android-sbn-key-1",
      packageName: "com.example.messages",
      title: "First account",
      body: "A notification for the first account",
    });
    const second = await recordDeviceNotification(secondUser, {
      id: "android-sbn-key-1",
      packageName: "com.example.messages",
      title: "Second account",
      body: "A notification for the second account",
    });

    assert.equal(first.id, second.id);
    assert.equal(state.deviceNotifications[firstUser][0].title, "First account");
    assert.equal(state.deviceNotifications[secondUser][0].title, "Second account");
  } finally {
    if (previous.first === undefined) delete state.deviceNotifications[firstUser];
    else state.deviceNotifications[firstUser] = previous.first;
    if (previous.second === undefined) delete state.deviceNotifications[secondUser];
    else state.deviceNotifications[secondUser] = previous.second;
  }
});

test("notification records require visible content", async () => {
  await assert.rejects(
    () =>
      recordDeviceNotification("notification-empty", {
        id: "empty",
        packageName: "com.example.noise",
      }),
    /** @param {any} error */
    (error) => error?.status === 400,
  );
});

test("notification retries are idempotent and package identifiers are validated", async () => {
  const userID = "notification-idempotency";
  const previous = state.deviceNotifications[userID];
  try {
    const first = await recordDeviceNotification(userID, {
      id: "android-sbn-idempotent",
      packageName: "com.example.mail",
      title: "First copy",
      body: "Keep one copy",
    });
    const retry = await recordDeviceNotification(
      userID,
      {
        id: "android-sbn-idempotent",
        packageName: "com.example.mail",
        title: "Different retry body",
        body: "The persisted row is authoritative",
      },
      { idempotencyKey: "android-sbn-idempotent" },
    );
    assert.deepEqual(retry, first);
    assert.equal(state.deviceNotifications[userID].length, 1);

    await assert.rejects(
      () =>
        recordDeviceNotification(
          userID,
          { id: "mismatch", packageName: "com.example.mail", title: "x" },
          { idempotencyKey: "different" },
        ),
      /** @param {any} error */
      (error) => error?.status === 400,
    );
    await assert.rejects(
      () => recordDeviceNotification(userID, { packageName: "not a package", title: "x" }),
      /** @param {any} error */
      (error) => error?.status === 400,
    );
  } finally {
    if (previous === undefined) delete state.deviceNotifications[userID];
    else state.deviceNotifications[userID] = previous;
  }
});

test("notification history drops expired entries and can be cleared per user", async () => {
  const firstUser = "notification-retention-first";
  const secondUser = "notification-retention-second";
  const previousFirst = state.deviceNotifications[firstUser];
  const previousSecond = state.deviceNotifications[secondUser];
  try {
    state.deviceNotifications[firstUser] = [
      {
        id: "old",
        userId: firstUser,
        packageName: "com.example.mail",
        appName: "Mail",
        title: "Expired",
        body: "Remove me",
        postedAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
        receivedAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      },
      {
        id: "fresh",
        userId: firstUser,
        packageName: "com.example.mail",
        appName: "Mail",
        title: "Keep me",
        body: "Still useful",
        postedAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
      },
    ];
    state.deviceNotifications[secondUser] = [
      {
        id: "other",
        userId: secondUser,
        packageName: "com.example.chat",
        appName: "Chat",
        title: "Other account",
        body: "Do not delete",
        postedAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
      },
    ];

    const visible = await getDeviceNotifications(firstUser, 10);
    assert.deepEqual(
      visible.map((entry) => entry.id),
      ["fresh"],
    );

    await clearDeviceNotifications(firstUser);
    assert.deepEqual(state.deviceNotifications[firstUser], undefined);
    assert.equal(state.deviceNotifications[secondUser][0].id, "other");
  } finally {
    if (previousFirst === undefined) delete state.deviceNotifications[firstUser];
    else state.deviceNotifications[firstUser] = previousFirst;
    if (previousSecond === undefined) delete state.deviceNotifications[secondUser];
    else state.deviceNotifications[secondUser] = previousSecond;
  }
});
