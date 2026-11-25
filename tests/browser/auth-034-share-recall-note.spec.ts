import {expect, type Page, test} from "@playwright/test";

import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const recallNote = /cannot be recalled/u;

test.describe("AUTH-034 in a browser", () => {
  test("AUTH-034 in a browser: the Share dialog mentions unrecallable copies only when leaving a public link", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const neverPublic = await publish("account_required", "Never public page");
      const publicPage = await publish("public_link", "Public page");
      await localLogin(fixture);

      const share = await openAccessEditor(fixture.page, neverPublic.body);
      await share.getByRole("radio", {name: /Only me/u}).check();
      await expect(share.getByText(recallNote)).toHaveCount(0);
      await share.getByRole("radio", {name: /Public link/u}).check();
      await expect(share.getByText(/The link can be redistributed/u)).toBeVisible();

      const leaving = await openAccessEditor(fixture.page, publicPage.body);
      await leaving.getByRole("radio", {name: /Signed-in members/u}).check();
      await expect(leaving.getByText(recallNote)).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }

    function publish(accessSetting: "account_required" | "public_link", name: string) {
      return publishNew(fixture.server, fixture.installation, {
        accessSetting,
        content: `<!doctype html><title>${name}</title><p>${name}</p>`,
        idempotencyKey: `auth-034-browser-${accessSetting}`,
        mediaType: "text/html; charset=utf-8",
        name,
        path: "index.html",
      });
    }

    async function openAccessEditor(page: Page, published: PublishResponse) {
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.artifact.id}&version=${published.version.id}`,
      );
      await page.locator(".as-preview-header__actions")
        .getByRole("button", {exact: true, name: "Share"})
        .click();
      const share = page.locator(".as-share-popover[data-open]");
      await share.getByRole("button", {name: "Manage access"}).click();
      await expect(share.getByRole("heading", {name: "Artifact access"})).toBeVisible();
      return share;
    }
  });
});
