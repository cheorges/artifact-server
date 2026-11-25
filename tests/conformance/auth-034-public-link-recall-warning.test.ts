import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const administratorToken = "trusted-installation-administrator";
const recall = "cannot be recalled";
const accessChangeSchema = z.object({
  artifact: z.object({accessSetting: z.string()}),
  replayed: z.boolean(),
  warning: z.string().nullable(),
});
const bulkSchema = z.object({
  summary: z.object({succeeded: z.number()}),
  warning: z.string().nullable(),
});
const toolCallResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: accessChangeSchema,
  }).loose(),
});

describe("public-link recall warning", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-034-B: ending a public link the installation serves warns over HTTP, MCP, and the bulk shutdown, and a replay repeats the warning", async () => {
    server = await startServer();
    const viaHttp = await publishPublic("auth-034-b-http-artifact");
    const viaMcp = await publishPublic("auth-034-b-mcp-artifact");
    const viaBulk = await publishPublic("auth-034-b-bulk-artifact");

    const http = await changeAccessOverHttp(viaHttp, "auth-034-b-http-private");
    expect(http.artifact.accessSetting).toBe("account_required");
    expect(http.warning).toContain(recall);
    const replay = await changeAccessOverHttp(viaHttp, "auth-034-b-http-private");
    expect(replay.replayed).toBe(true);
    expect(replay.warning).toContain(recall);

    const mcp = await changeAccessOverMcp(viaMcp, "auth-034-b-mcp-private");
    expect(mcp.artifact.accessSetting).toBe("account_required");
    expect(mcp.warning).toContain(recall);

    const bulk = await makePrivateInBulk(viaBulk, "auth-034-b-bulk-private");
    expect(bulk.summary.succeeded).toBe(1);
    expect(bulk.warning).toContain(recall);
  });

  test("AUTH-034-F: an access change carries no recall warning when the artifact had no public link, or when the installation turns public links off", async () => {
    server = await startServer();
    const ended = await publishPublic("auth-034-f-ended-artifact");
    expect((await changeAccessOverHttp(ended, "auth-034-f-ended-private")).warning)
      .toContain(recall);
    const again = await changeAccessOverHttp(ended, "auth-034-f-ended-again");
    expect(again.replayed).toBe(false);
    expect(again.warning).toBeNull();
    expect((await changeAccessOverMcp(ended, "auth-034-f-ended-mcp")).warning)
      .toBeNull();

    const viaHttp = await publishPublic("auth-034-f-http-artifact");
    const viaMcp = await publishPublic("auth-034-f-mcp-artifact");
    const viaBulk = await publishPublic("auth-034-f-bulk-artifact");
    await server.stop();
    server = await startServer({publicLinks: "off"});

    const http = await changeAccessOverHttp(viaHttp, "auth-034-f-http-private");
    expect(http.artifact.accessSetting).toBe("account_required");
    expect(http.warning).toBeNull();
    const mcp = await changeAccessOverMcp(viaMcp, "auth-034-f-mcp-private");
    expect(mcp.artifact.accessSetting).toBe("account_required");
    expect(mcp.warning).toBeNull();
    const bulk = await makePrivateInBulk(viaBulk, "auth-034-f-bulk-private");
    expect(bulk.summary.succeeded).toBe(1);
    expect(bulk.warning).toBeNull();
  });

  function startServer(
    options: {readonly publicLinks?: "off" | "on"} = {},
  ): Promise<RunningTestServer> {
    return startTestServer(installation, {
      ...options,
      externalApiBearerVerifier: administratorVerifier,
    });
  }

  async function publishPublic(name: string): Promise<PublishResponse> {
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: `<!doctype html><title>${name}</title>`,
      idempotencyKey: name,
      name,
    });
    expect(published.response.status).toBe(201);
    return published.body;
  }

  async function changeAccessOverHttp(
    published: PublishResponse,
    idempotencyKey: string,
  ) {
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/access`,
      {
        body: JSON.stringify({
          accessSetting: "account_required",
          expectedCurrentVersionId: published.version.id,
        }),
        headers: apiHeaders(installation, idempotencyKey),
        method: "PATCH",
      },
    );
    expect(response.status).toBe(200);
    return accessChangeSchema.parse(await response.json());
  }

  async function changeAccessOverMcp(
    published: PublishResponse,
    idempotencyKey: string,
  ) {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
          arguments: {
            accessSetting: "account_required",
            artifactId: published.artifact.id,
            expectedCurrentVersionId: published.version.id,
            idempotencyKey,
          },
          name: "artifact_set_visibility",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "artifact_set_visibility",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const result = toolCallResultSchema.parse(await response.json()).result;
    expect(result.isError).not.toBe(true);
    return result.structuredContent;
  }

  async function makePrivateInBulk(
    published: PublishResponse,
    idempotencyKey: string,
  ) {
    const response = await fetch(
      `${server.baseUrl}/api/v1/administration/public-links/make-private`,
      {
        body: JSON.stringify({
          items: [{
            artifactId: published.artifact.id,
            expectedCurrentVersionId: published.version.id,
            idempotencyKey,
            projectId: published.artifact.projectId,
          }],
        }),
        headers: {
          Authorization: `Bearer ${administratorToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    return bulkSchema.parse(await response.json());
  }
});

const administratorVerifier: BearerCredentialVerifier = {
  verify: (credential) =>
    Redacted.value(credential) === administratorToken
      ? Effect.succeed({
        authorizedByPrincipalId: null,
        capabilities: [],
        displayName: "Installation administrator",
        id: "installation-administrator",
        installationId: "local",
        kind: "human",
        membershipRole: "administrator",
      })
      : Effect.fail(new AuthenticationRequired({
        message: "The external administrator credential is invalid.",
      })),
};
