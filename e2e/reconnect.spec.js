/* =============================================================================
 * e2e/reconnect.spec.js — the reconnect happy path (item 29), driven through two
 * REAL browser contexts against the real server. This is the one path unit tests
 * can't fully cover: a person's connection drops mid-room (phone lock / wifi blip)
 * and the browser client must quietly rejoin the same room by its stable clientId.
 * ========================================================================== */
const { test, expect } = require('@playwright/test');

const rpCount = (page) => page.locator('.rp').count();

test('a dropped client reconnects into the same room by stable clientId', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();

  // --- A starts a live room ---
  await A.goto('/');
  await A.click('#live-btn');
  await A.fill('#rm-name', 'Ava');
  await A.click('#rm-create');
  await A.waitForSelector('.room-code b', { timeout: 15000 });
  const code = (await A.textContent('.room-code b')).trim();
  expect(code).toMatch(/^[A-Z0-9]{4}$/);

  // --- B joins with the code ---
  await B.goto('/');
  await B.click('#live-btn');
  await B.fill('#rm-name', 'Ben');
  await B.fill('#rm-code', code);
  await B.click('#rm-join-btn');
  await B.waitForSelector('.room-code b', { timeout: 15000 });

  // --- both screens see two people ---
  await expect.poll(() => rpCount(A), { timeout: 10000 }).toBe(2);
  await expect.poll(() => rpCount(B), { timeout: 10000 }).toBe(2);

  // --- A drops (wifi blip) then comes back ---
  await ctxA.setOffline(true);
  await A.waitForTimeout(2000);           // let the socket close + a reconnect attempt fail
  await ctxA.setOffline(false);

  // --- A quietly rejoins the SAME room; the roster is whole again on both ---
  await expect.poll(() => rpCount(A), { timeout: 20000 }).toBe(2);
  await expect(A.locator('.room-code b')).toHaveText(code);        // still the same room
  await expect.poll(() => rpCount(B), { timeout: 20000 }).toBe(2); // B never lost A's seat

  await ctxA.close();
  await ctxB.close();
});
