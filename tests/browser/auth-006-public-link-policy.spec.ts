import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

test.describe("Installation public-link policy", () => {
  test("AUTH-006: the Share dialog offers no public link when the installation turns public links off", async ({browser}) => {
    const fixture = await startBrowserFixture(browser, {}, {publicLinks: "off"});
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Policy page</title><p>Policy page</p>",
        idempotencyKey: "auth-006-browser-share",
        mediaType: "text/html; charset=utf-8",
        name: "Policy page",
        path: "index.html",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );

      await fixture.page.locator(".as-preview-header__actions")
        .getByRole("button", {exact: true, name: "Share"})
        .click();
      const share = fixture.page.locator(".as-share-popover[data-open]");
      await share.getByRole("button", {name: "Manage access"}).click();
      await expect(share.getByRole("heading", {name: "Artifact access"})).toBeVisible();
      await expect(share.getByRole("radio", {name: /Signed-in members/u})).toBeVisible();
      await expect(share.getByRole("radio", {name: /Public link/u})).toHaveCount(0);
      await expect(share.getByText(/Public access does not create a tunnel/u)).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
