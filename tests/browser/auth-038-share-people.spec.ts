import {expect, test} from "@playwright/test";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const memberSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({token: z.string().startsWith("as_key_")});

test.describe("AUTH-038 in a browser", () => {
  test("AUTH-038 in a browser: the Share dialog adds and removes people, keeps them while another setting is chosen, and refuses a malformed address", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Team plan</title><p>Team plan</p>",
        idempotencyKey: "auth-038-browser-team-plan",
        mediaType: "text/html; charset=utf-8",
        name: "Team plan",
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

      const people = share.getByRole("group", {name: "People with access"});
      await expect(people.getByText(/Kept for when you switch back/u)).toBeVisible();
      await share.getByRole("radio", {name: /Only me and people I add/u}).check();
      await expect(people.getByText(/Kept for when you switch back/u)).toHaveCount(0);

      await people.getByRole("textbox", {name: "Email address"}).fill(" Ben@Example.test ");
      await people.getByRole("button", {exact: true, name: "Add"}).click();
      await expect(people.getByRole("listitem")).toHaveText(["ben@example.test"]);
      await expect(people.getByRole("textbox", {name: "Email address"})).toHaveValue("");

      await people.getByRole("textbox", {name: "Email address"}).fill("not-an-address");
      await people.getByRole("button", {exact: true, name: "Add"}).click();
      await expect(people.getByRole("alert")).toContainText("is not a valid email address");

      await people.getByRole("button", {name: "Remove ben@example.test"}).click();
      await expect(people.getByRole("listitem")).toHaveCount(0);

      await share.getByRole("button", {exact: true, name: "Save"}).click();
      await expect(share.getByRole("status"))
        .toContainText("Only you, installation administrators, and the people you add");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("AUTH-038 in a browser: an address added while the list is still loading stays listed", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Slow list</title><p>Slow list</p>",
        idempotencyKey: "auth-038-browser-slow-list",
        mediaType: "text/html; charset=utf-8",
        name: "Slow list",
        path: "index.html",
      });
      await localLogin(fixture);
      const page = fixture.page;
      // The first read of the list answers what was true before the add, but
      // only after the add has finished.
      let releaseList = (): void => undefined;
      const listHeld = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      await page.route(/\/api\/v1\/artifacts\/[^/]+\/grants\?/u, async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await listHeld;
        await route.fulfill({json: {active: false, grants: []}});
      });
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );
      await page.locator(".as-preview-header__actions")
        .getByRole("button", {exact: true, name: "Share"})
        .click();
      const share = page.locator(".as-share-popover[data-open]");
      await share.getByRole("button", {name: "Manage access"}).click();
      const people = share.getByRole("group", {name: "People with access"});

      await people.getByRole("textbox", {name: "Email address"}).fill("ben@example.test");
      const added = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/grants") && response.request().method() === "PATCH");
      await people.getByRole("button", {exact: true, name: "Add"}).click();
      expect((await added).status()).toBe(200);
      await expect(people.getByRole("listitem")).toHaveText(["ben@example.test"]);

      const listed = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/grants") && response.request().method() === "GET");
      releaseList();
      await listed;
      await expect(people.getByRole("listitem")).toHaveText(["ben@example.test"]);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("AUTH-037 in a browser: the Shared with me filter lists only restricted pages others shared with the viewer", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const administrator = await signInAdministrator(fixture.server, fixture.installation);
      const adminHeaders = {
        "Content-Type": "application/json",
        Cookie: administrator.header,
        Origin: fixture.server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": administrator.csrf,
      };
      const admitted = await fetch(`${fixture.server.baseUrl}/api/v1/members`, {
        body: JSON.stringify({displayName: "Ben Beispiel", email: "ben@example.test"}),
        headers: adminHeaders,
        method: "POST",
      });
      expect(admitted.status).toBe(201);
      const key = await fetch(`${fixture.server.baseUrl}/api/v1/api-keys`, {
        body: JSON.stringify({
          capabilities: ["artifact:create", "artifact:manage:any", "artifact:publish:any", "artifact:read"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          memberId: memberSchema.parse(await admitted.json()).member.id,
          name: "Ben's key",
        }),
        headers: adminHeaders,
        method: "POST",
      });
      expect(key.status).toBe(201);
      const benToken = issuedKeySchema.parse(await key.json()).token;
      const ben = {...fixture.installation, apiToken: benToken};
      const shared = await publishNew(fixture.server, ben, {
        accessSetting: "restricted",
        content: "<!doctype html><title>Ben's draft</title>",
        idempotencyKey: "auth-037-browser-ben-draft",
        name: "Ben's draft",
      });
      await publishNew(fixture.server, ben, {
        accessSetting: "restricted",
        content: "<!doctype html><title>Ben's notes</title>",
        idempotencyKey: "auth-037-browser-ben-notes",
        name: "Ben's notes",
      });
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Team page</title>",
        idempotencyKey: "auth-037-browser-team-page",
        name: "Team page",
      });
      const granted = await fetch(
        `${fixture.server.baseUrl}/api/v1/artifacts/${shared.body.artifact.id}/grants`,
        {
          body: JSON.stringify({add: ["administrator@example.test"]}),
          headers: {Authorization: `Bearer ${benToken}`, "Content-Type": "application/json"},
          method: "PATCH",
        },
      );
      expect(granted.status).toBe(200);

      await localLogin(fixture);
      const page = fixture.page;
      await page.getByRole("button", {name: /^Filter artifacts/u}).click();
      const filtered = page.waitForRequest(/\/api\/v1\/artifacts\?.*scope=shared_with_me/u);
      await page.getByRole("radio", {name: "Shared with me"}).check();
      await filtered;
      await page.keyboard.press("Escape");
      await expect(page.locator(".as-artifact-card")).toHaveCount(1);
      await expect(page.locator(".as-artifact-card")).toContainText("Ben's draft");
      await expect(page.getByRole("button", {name: /^Filter artifacts/u})).toContainText("Shared with me");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
