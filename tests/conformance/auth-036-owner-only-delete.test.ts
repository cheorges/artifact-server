import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const refusal = "Only the owner or an administrator can delete this artifact.";
const allCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
] as const;

const artifactSchema = z.object({
  currentVersionId: z.string(),
  id: z.string(),
  projectId: z.string(),
});
const deletionSchema = z.object({
  artifact: z.object({deletedAt: z.string(), id: z.string()}),
});
const errorSchema = z.object({error: z.object({code: z.string(), message: z.string()})});
const listSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({id: z.string()})})),
});
const toolResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});
const memberSchema = z.object({member: z.object({id: z.string()})});
const sessionSchema = z.object({principal: z.object({id: z.string()})});
const issuedKeySchema = z.object({
  apiKey: z.object({principalId: z.string()}),
  token: z.string().startsWith("as_key_"),
});

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** A caller that authenticates with an API key. */
interface Actor {
  readonly id: string;
  readonly token: string;
}

type Artifact = z.infer<typeof artifactSchema>;

describe("owner-only delete", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let administrator: ApplicationCookies;
  let ada: Actor;
  let ben: Actor;
  let bot: Actor;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    administrator = await signInAdministrator(server, installation);
    ada = await memberWithKey("Ada Lovelace", "ada@example.test");
    ben = await memberWithKey("Ben Beispiel", "ben@example.test");
    bot = await issueKey(undefined, "Release bot");
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-036-B: the owner deletes over HTTP and MCP, a service key deletes what it published, an administrator deletes any artifact, and another member still makes a version current", async () => {
    const overHttp = await publishAs(ada, "Ada over HTTP");
    const overMcp = await publishAs(ada, "Ada over MCP");
    const byBen = await publishAs(ben, "Ben's page");
    const byBot = await publishAs(bot, "Bot page");
    const restored = await publishAs(ada, "Ada restored by Ben");

    const httpDeletion = await deleteOverHttp(ada, overHttp);
    expect(httpDeletion.status).toBe(200);
    expect(deletionSchema.parse(await httpDeletion.json()).artifact.id).toBe(overHttp.id);

    const mcpDeletion = await callTool(ada, "artifact_delete", {
      artifactId: overMcp.id,
      expectedCurrentVersionId: overMcp.currentVersionId,
      idempotencyKey: "auth-036-b-mcp-delete",
    });
    expect(mcpDeletion.isError).not.toBe(true);
    expect((await deleteOverHttp(bot, byBot)).status).toBe(200);

    const administratorDeletion = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${byBen.id}`,
      {
        body: JSON.stringify({expectedCurrentVersionId: byBen.currentVersionId}),
        headers: {...browserMutationHeaders(), "Idempotency-Key": crypto.randomUUID()},
        method: "DELETE",
      },
    );
    expect(administratorDeletion.status).toBe(200);

    const second = await publishVersion(server, as(ada), {
      artifactId: restored.id,
      content: "Ada's second version",
      expectedCurrentVersionId: restored.currentVersionId,
      idempotencyKey: "auth-036-b-second-version",
      projectId: restored.projectId,
    });
    expect(second.response.status).toBe(201);
    const madeCurrent = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${restored.id}/restore`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: second.body.version.id,
          versionId: restored.currentVersionId,
        }),
        headers: headersFor(ben, {idempotent: true, json: true}),
        method: "POST",
      },
    );
    expect(madeCurrent.status).toBe(200);

    expect(await listedIds(ben)).toEqual([restored.id]);
  });

  test("AUTH-036-F: another member, a service key with artifact:manage:any, and an administrator acting through their own API key cannot delete someone else's artifact, and it stays listed", async () => {
    const adaPage = await publishAs(ada, "Ada's page");
    const benPage = await publishAs(ben, "Ben's page");

    const byMember = await deleteOverHttp(ben, adaPage);
    expect(byMember.status).toBe(403);
    expect(errorSchema.parse(await byMember.json()).error).toEqual({
      code: "AUTHORIZATION_DENIED",
      message: refusal,
    });
    const overMcp = await callTool(ben, "artifact_delete", {
      artifactId: adaPage.id,
      expectedCurrentVersionId: adaPage.currentVersionId,
      idempotencyKey: "auth-036-f-mcp-delete",
    });
    expect(overMcp.isError).toBe(true);
    expect(overMcp.content[0]?.text).toContain(refusal);

    const byService = await deleteOverHttp(bot, adaPage);
    expect(byService.status).toBe(403);
    expect(errorSchema.parse(await byService.json()).error.message).toBe(refusal);
    const byOtherMember = await deleteOverHttp(ada, benPage);
    expect(byOtherMember.status).toBe(403);

    // Signed in as themselves an administrator may delete anything; their own
    // API key acts as their member and owns only what they published.
    const administratorId = sessionSchema.parse(await (await fetch(
      `${server.baseUrl}/api/v1/session`,
      {headers: browserMutationHeaders()},
    )).json()).principal.id;
    const administratorKey = await issueKey(administratorId, "Administrator's key");
    const byAdministratorKey = await deleteOverHttp(administratorKey, adaPage);
    expect(byAdministratorKey.status).toBe(403);
    expect(errorSchema.parse(await byAdministratorKey.json()).error).toEqual({
      code: "AUTHORIZATION_DENIED",
      message: refusal,
    });

    expect((await listedIds(ben)).toSorted()).toEqual([adaPage.id, benPage.id].toSorted());
  });

  async function memberWithKey(displayName: string, email: string): Promise<Actor> {
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName, email}),
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(admitted.status).toBe(201);
    const memberId = memberSchema.parse(await admitted.json()).member.id;
    return issueKey(memberId, `${displayName}'s key`);
  }

  async function issueKey(memberId: string | undefined, name: string): Promise<Actor> {
    const request = {
      capabilities: [...allCapabilities],
      expiresAt: "2099-01-01T00:00:00.000Z",
      name,
    };
    const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify(memberId === undefined ? request : {...request, memberId}),
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(response.status).toBe(201);
    const issued = issuedKeySchema.parse(await response.json());
    return {id: issued.apiKey.principalId, token: issued.token};
  }

  function as(actor: Actor): TestInstallation {
    return {...installation, apiToken: actor.token};
  }

  async function publishAs(actor: Actor, name: string): Promise<Artifact> {
    const published = await publishNew(server, as(actor), {
      accessSetting: "account_required",
      content: name,
      idempotencyKey: `publish-${name}-${actor.id}`,
      name,
    });
    expect(published.response.status).toBe(201);
    return artifactSchema.parse(published.body.artifact);
  }

  function deleteOverHttp(actor: Actor, artifact: Artifact): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifact.id}`, {
      body: JSON.stringify({expectedCurrentVersionId: artifact.currentVersionId}),
      headers: headersFor(actor, {idempotent: true, json: true}),
      method: "DELETE",
    });
  }

  async function listedIds(actor: Actor): Promise<string[]> {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: headersFor(actor),
    });
    expect(response.status).toBe(200);
    return listSchema.parse(await response.json()).artifacts.map(({artifact}) => artifact.id);
  }

  async function callTool(actor: Actor, name: string, toolArguments: McpParameters) {
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
          arguments: toolArguments,
          name,
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${actor.token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    return toolResultSchema.parse(await response.json()).result;
  }

  function browserMutationHeaders() {
    return {
      "Content-Type": "application/json",
      Cookie: administrator.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": administrator.csrf,
    };
  }
});

function headersFor(
  actor: Actor,
  options: {readonly idempotent?: boolean; readonly json?: boolean} = {},
): Headers {
  const headers = new Headers({Authorization: `Bearer ${actor.token}`});
  if (options.json === true) headers.set("Content-Type", "application/json");
  if (options.idempotent === true) {
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  return headers;
}

interface McpParameters {
  readonly [key: string]: McpParameterValue;
}

type McpParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpParameterValue[]
  | McpParameters;
