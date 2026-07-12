/* =============================================================================
 * e2e/room-flow.spec.js — the full live-room experience through real browsers:
 * two people settle a verdict together, chat relays, a spectator joins and is
 * marked as such, and the host kicks them. Complements the reconnect spec (the
 * server side of each is unit-tested; this proves the client wires it up).
 * ========================================================================== */
const { test, expect } = require('@playwright/test');

async function createRoom(page, name) {
  await page.goto('/');
  await page.click('#live-btn');
  await page.fill('#rm-name', name);
  await page.click('#rm-create');
  await page.waitForSelector('.room-code b', { timeout: 15000 });
  return (await page.textContent('.room-code b')).trim();
}
async function joinRoom(page, name, code, spectate = false) {
  await page.goto('/');
  await page.click('#live-btn');
  await page.fill('#rm-name', name);
  await page.fill('#rm-code', code);
  if (spectate) await page.check('#rm-spectate');
  await page.click('#rm-join-btn');
  await page.waitForSelector('.room-code b', { timeout: 15000 });
}

test('two people settle together; chat relays; a spectator joins and is kicked', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const C = await ctxC.newPage();
  A.on('dialog', (d) => d.accept());   // auto-confirm host kick/handoff prompts

  // --- create + join ---
  const code = await createRoom(A, 'Ava');
  await joinRoom(B, 'Ben', code);
  await expect.poll(() => A.locator('.rp').count(), { timeout: 10000 }).toBe(2);

  // --- both set a taste so the host can settle ---
  await A.click('.room-you-grid .chip[data-genre="Comedy"]');
  await B.click('.room-you-grid .chip[data-genre="Drama"]');
  await expect(A.locator('#resolve-btn')).toBeEnabled({ timeout: 10000 });

  // --- host settles → the SAME verdict lands on both screens ---
  await A.click('#resolve-btn');
  await A.waitForSelector('.verdict .p-title', { timeout: 25000 });
  await B.waitForSelector('.verdict .p-title', { timeout: 25000 });
  const [pickA, pickB] = [await A.textContent('.verdict .p-title'), await B.textContent('.verdict .p-title')];
  expect(pickA).toBe(pickB);

  // --- chat relays A → B ---
  await A.fill('#chat-input', 'popcorn time');
  await A.press('#chat-input', 'Enter');
  await expect(B.locator('.chat-msg')).toContainText('popcorn time', { timeout: 10000 });

  // --- a spectator joins: roster marks them, they get the spectator card, no vote ---
  await joinRoom(C, 'Cy', code, true);
  await expect.poll(() => A.locator('.rp').count(), { timeout: 10000 }).toBe(3);
  await expect(A.locator('.rp .rp-tag.spec')).toHaveCount(1);
  await expect(C.locator('.spectator-card')).toBeVisible();

  // --- host kicks the spectator → they're returned to solo, roster back to two ---
  await A.locator('.rp', { hasText: 'Cy' }).locator('[data-kick]').click();
  await expect(C.locator('.room-code b')).toHaveCount(0, { timeout: 10000 });   // C left the room
  await expect.poll(() => A.locator('.rp').count(), { timeout: 10000 }).toBe(2);

  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
});
