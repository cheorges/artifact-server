import {expect, test} from "@playwright/test";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const sessionSchema = z.object({principal: z.object({id: z.string()})});
const memberSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({token: z.string().startsWith("as_key_")});

test.describe("AUTH-035 in a browser", () => {
  test("AUTH-035 in a browser: the catalog, Details, and Activity name the owner, and Mine lists only the viewer's artifacts", async ({browser}) => {
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
      const session = sessionSchema.parse(await (await fetch(
        `${fixture.server.baseUrl}/api/v1/session`,
        {headers: adminHeaders},
      )).json());
      const admitted = await fetch(`${fixture.server.baseUrl}/api/v1/members`, {
        body: JSON.stringify({displayName: "Ben Beispiel", email: "ben@example.test"}),
        headers: adminHeaders,
        method: "POST",
      });
      expect(admitted.status).toBe(201);
      const benId = memberSchema.parse(await admitted.json()).member.id;
      const keyFor = async (memberId: string, name: string): Promise<string> => {
        const response = await fetch(`${fixture.server.baseUrl}/api/v1/api-keys`, {
          body: JSON.stringify({
            capabilities: ["artifact:create", "artifact:read"],
            expiresAt: "2099-01-01T00:00:00.000Z",
            memberId,
            name,
          }),
          headers: adminHeaders,
          method: "POST",
        });
        expect(response.status).toBe(201);
        return issuedKeySchema.parse(await response.json()).token;
      };
      const ownToken = await keyFor(session.principal.id, "Viewer's key");
      const benToken = await keyFor(benId, "Ben's key");
      await publishNew(fixture.server, {...fixture.installation, apiToken: ownToken}, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Viewer page</title>",
        idempotencyKey: "auth-035-browser-viewer-page",
        name: "Viewer page",
      });
      await publishNew(fixture.server, {...fixture.installation, apiToken: benToken}, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Ben page</title>",
        idempotencyKey: "auth-035-browser-ben-page",
        name: "Ben page",
      });

      await localLogin(fixture);
      const page = fixture.page;
      const benCard = page.locator(".as-artifact-card", {hasText: "Ben page"});
      await expect(benCard.getByText("by Ben Beispiel")).toBeVisible();

      await benCard.click();
      await page.getByRole("tab", {name: "Details"}).click();
      await expect(page.locator(".as-inspector-row", {hasText: "owner"}))
        .toContainText("Ben Beispiel");
      await page.getByRole("tab", {name: "Activity"}).click();
      await expect(page.locator(".as-activity-list")).toContainText("Ben Beispiel");

      await page.getByRole("button", {name: /^Filter artifacts/u}).click();
      await page.getByRole("radio", {name: "Mine"}).check();
      await page.keyboard.press("Escape");
      await expect(page.locator(".as-artifact-card", {hasText: "Viewer page"})).toBeVisible();
      await expect(page.locator(".as-artifact-card", {hasText: "Ben page"})).toHaveCount(0);
      await expect(page.getByRole("button", {name: /^Filter artifacts/u})).toContainText("Mine");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
