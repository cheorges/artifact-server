import {expect, test} from "@playwright/test";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const memberSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({token: z.string().startsWith("as_key_")});

test.describe("AUTH-036 in a browser", () => {
  test("AUTH-036 in a browser: Make current on a colleague's page names the owner, and an administrator is offered Delete", async ({browser}) => {
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
          capabilities: ["artifact:create", "artifact:publish:any", "artifact:read"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          memberId: memberSchema.parse(await admitted.json()).member.id,
          name: "Ben's key",
        }),
        headers: adminHeaders,
        method: "POST",
      });
      expect(key.status).toBe(201);
      const ben = {
        ...fixture.installation,
        apiToken: issuedKeySchema.parse(await key.json()).token,
      };
      const first = await publishNew(fixture.server, ben, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Ben one</title>",
        idempotencyKey: "auth-036-browser-ben-first",
        name: "Ben page",
      });
      await publishVersion(fixture.server, ben, {
        artifactId: first.body.artifact.id,
        content: "<!doctype html><title>Ben two</title>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "auth-036-browser-ben-second",
      });

      await localLogin(fixture);
      const page = fixture.page;
      await page.locator(".as-artifact-card", {hasText: "Ben page"}).click();
      await page.getByRole("tab", {name: "Details"}).click();
      await expect(page.getByRole("heading", {name: "Danger zone"})).toBeVisible();

      await page.getByRole("tab", {name: /^Versions/u}).click();
      await page.getByRole("button", {name: "Make current"}).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("This page belongs to Ben Beispiel.");
      await dialog.getByRole("button", {name: "Make current"}).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".as-version-list__state", {hasText: "current"}))
        .toHaveCount(1);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
