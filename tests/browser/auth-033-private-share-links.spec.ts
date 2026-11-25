import {expect, test} from "@playwright/test";

import {publishNew, publishVersion} from "../support/publishing.js";
import {reserveLoopbackPort} from "../support/runtime-harness.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

test.describe("AUTH-033 in a browser", () => {
  test("AUTH-033 in a browser: a signed-in member opens a private artifact's Latest and Raw links", async ({browser}) => {
    const port = await reserveLoopbackPort();
    const fixture = await startBrowserFixture(browser, {}, {
      applicationOrigin: `http://127.0.0.1:${port}`,
      port,
    });
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Browser first</title><h1>Browser first</h1>",
        idempotencyKey: "auth-033-browser-first",
        name: "Browser share links",
        path: "docs/page.html",
      });
      const second = await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: "<!doctype html><title>Browser second</title><h1>Browser second</h1>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "auth-033-browser-second",
        path: "docs/page.html",
      });
      await localLogin(fixture);

      // Pasted into the address bar, as from a chat message or an email.
      await fixture.page.goto(first.body.links.artifact);
      await expect(fixture.page.getByRole("heading", {name: "Browser second"}))
        .toBeVisible();
      expect(new URL(fixture.page.url()).origin)
        .toBe(new URL(second.body.links.version).origin);
      expect(fixture.page.url()).not.toContain("__artifact_bootstrap");

      const rawUrl = new URL("/docs/page.html", first.body.links.version).toString();
      await fixture.page.goto(rawUrl);
      await expect(fixture.page.getByRole("heading", {name: "Browser first"}))
        .toBeVisible();
      expect(fixture.page.url()).toBe(rawUrl);

      // Followed from the application, a cross-site navigation to the content domain.
      const reviewPage = await fixture.context.newPage();
      await reviewPage.goto(first.body.links.review);
      await reviewPage.evaluate((href) => {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = "Raw from Review";
        document.body.append(link);
      }, second.body.links.version);
      await reviewPage.getByRole("link", {name: "Raw from Review"}).click();
      await expect(reviewPage.getByRole("heading", {name: "Browser second"}))
        .toBeVisible();
      expect(new URL(reviewPage.url()).origin)
        .toBe(new URL(second.body.links.version).origin);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
