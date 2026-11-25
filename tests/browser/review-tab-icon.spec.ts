import {expect, test, type Page} from "@playwright/test";

import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

// The server answers only the routes it knows, so an icon link to a path it
// does not serve leaves the browser tab without an icon.
test("the review application and review frame link a tab icon the server serves", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    await localLogin(fixture);
    await expectServedTabIcon(fixture.page);

    await fixture.page.goto(`${fixture.server.baseUrl}/review-frame`);
    await expectServedTabIcon(fixture.page);
  } finally {
    await stopBrowserFixture(fixture);
  }
});

async function expectServedTabIcon(page: Page): Promise<void> {
  const href = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(href, page.url()).not.toBeNull();
  const icon = await page.request.get(new URL(href ?? "", page.url()).href);
  expect(icon.status(), page.url()).toBe(200);
  expect(icon.headers()["content-type"], page.url()).toBe("image/svg+xml");
}
