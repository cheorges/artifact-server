import {expect, test} from "@playwright/test";

import {createFakeGroupDirectory} from "../support/fake-group-directory.js";
import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";

async function openManageAccess(fixture: BrowserFixture, name: string) {
  const published = await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: `<!doctype html><title>${name}</title><p>${name}</p>`,
    idempotencyKey: `auth-040-browser-${name.toLowerCase().replaceAll(" ", "-")}`,
    mediaType: "text/html; charset=utf-8",
    name,
    path: "index.html",
  });
  await localLogin(fixture);
  const page = fixture.page;
  await page.goto(
    `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
  );
  await page.locator(".as-preview-header__actions")
    .getByRole("button", {exact: true, name: "Share"})
    .click();
  const share = page.locator(".as-share-popover[data-open]");
  await share.getByRole("button", {name: "Manage access"}).click();
  return share;
}

test.describe("AUTH-040 in a browser", () => {
  test("AUTH-040 in a browser: the owner shares with a group found by name, removes it, and sees why a search finds nothing or fails", async ({browser}) => {
    const directory = createFakeGroupDirectory();
    directory.addGroup(
      {displayName: "Developer Productivity", id: "11111111-1111-4111-8111-111111111111", mail: "dep@example.test"},
      [],
    );
    directory.addGroup(
      {displayName: "Developer Experience Guild", id: "22222222-2222-4222-8222-222222222222", mail: null},
      [],
    );
    const fixture = await startBrowserFixture(browser, {}, {
      groupSharing: {directory, identityProvider: "oidc:https://issuer.example.test"},
    });
    try {
      const share = await openManageAccess(fixture, "Team plan");
      await share.getByRole("radio", {name: /Only me and people I add/u}).check();
      const groups = share.getByRole("group", {name: "Groups with access"});
      const search = groups.getByRole("textbox", {name: "Group name or address"});
      await expect(search).toHaveAttribute("placeholder", "Search groups by name or address");

      await search.fill("d");
      await expect(groups.getByRole("option")).toHaveCount(0);
      await search.fill("devel");
      await expect(groups.getByRole("option")).toHaveText([
        /Developer Productivity\s*dep@example\.test/u,
        /Developer Experience Guild/u,
      ]);
      await groups.getByRole("option", {name: /Developer Productivity/u}).click();
      await expect(groups.getByRole("listitem")).toHaveText(["Developer Productivity"]);
      await expect(search).toHaveValue("");
      await expect(groups.getByRole("option")).toHaveCount(0);

      // People and groups are separate lists.
      const people = share.getByRole("group", {name: "People with access"});
      await expect(people.getByRole("listitem")).toHaveCount(0);

      await search.fill("ductiv");
      await expect(groups.getByText("No group found. The search matches the start of a word.")).toBeVisible();

      directory.failNext(1);
      await search.fill("dep@example.test");
      await expect(groups.getByRole("alert")).toContainText("The directory cannot be reached");

      await groups.getByRole("button", {name: "Remove Developer Productivity"}).click();
      await expect(groups.getByRole("listitem")).toHaveCount(0);

      await fixture.page.keyboard.press("Escape");
      await fixture.page.getByRole("tab", {name: "Activity"}).click();
      const activity = fixture.page.locator(".as-activity-list li");
      await expect(activity.filter({hasText: "Shared with group Developer Productivity"})).toHaveCount(1);
      await expect(activity.filter({hasText: "Stopped sharing with group Developer Productivity"})).toHaveCount(1);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("AUTH-040 in a browser: without a directory the Share dialog has no Groups field", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const share = await openManageAccess(fixture, "Plan without groups");
      await expect(share.getByRole("group", {name: "People with access"})).toBeVisible();
      await expect(share.getByRole("group", {name: "Groups with access"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
