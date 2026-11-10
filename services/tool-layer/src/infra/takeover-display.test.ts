import assert from "node:assert/strict";
import { test } from "node:test";

import { TakeoverDisplayPool } from "./takeover-display.js";

const USER_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const USER_B = "9c858901-8a57-4791-81fe-4c455b099bc9";

test("detach frees the slot and its ports", async () => {
  const pool = new TakeoverDisplayPool({ maxSlots: 1 });
  const lease = await pool.acquire(USER_A);
  pool.detach(USER_A);
  assert.equal(pool.wsPortFor(USER_A), undefined);
  assert.equal(pool.displayFor(USER_A), undefined);
  // The freed port is immediately available to the same or another user.
  const next = await pool.acquire(USER_B);
  assert.equal(next.wsPort, lease.wsPort);
  assert.equal(next.rfbPort, lease.rfbPort);
});

test("detach and release are idempotent once the slot is gone", async () => {
  const pool = new TakeoverDisplayPool({ maxSlots: 1 });
  await pool.acquire(USER_A);
  pool.detach(USER_A);
  assert.doesNotThrow(() => pool.detach(USER_A));
  assert.doesNotThrow(() => pool.release(USER_A));
});

test("a live slot is still exclusive until it is detached", async () => {
  const pool = new TakeoverDisplayPool({ maxSlots: 1 });
  const lease = await pool.acquire(USER_A);
  assert.equal(await pool.acquire(USER_A), lease);
  await assert.rejects(() => pool.acquire(USER_B), /live browser is busy/);
});
