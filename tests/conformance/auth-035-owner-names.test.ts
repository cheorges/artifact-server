import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const allCapabilities = [
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
] as const;

const artifactSchema = z.object({
  currentVersionId: z.string(),
  id: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string().nullable(),
  projectId: z.string(),
});
const listSchema = z.object({
  artifacts: z.array(z.object({
    artifact: artifactSchema,
    ownerDisplayName: z.string().nullable(),
  })),
});
const detailsSchema = z.object({
  artifact: artifactSchema,
  ownerDisplayName: z.string().nullable(),
});
const actionsSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    actorDisplayName: z.string().nullable(),
    principalId: z.string(),
  })),
});
const mcpListSchema = z.object({
  artifacts: z.array(z.object({
    name: z.string(),
    ownerDisplayName: z.string().nullable(),
  })),
});
const mcpGetSchema = z.object({
  artifact: artifactSchema,
  ownerDisplayName: z.string().nullable(),
});
const toolResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});
const memberSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({
  apiKey: z.object({principalId: z.string()}),
  token: z.string().startsWith("as_key_"),
});
const errorSchema = z.object({error: z.object({code: z.string()})});

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** A caller that authenticates with an API key. */
interface Actor {
  readonly id: string;
  readonly token: string;
}

describe("owner and actor names", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let administrator: ApplicationCookies;
  let ada: Actor & {readonly memberId: string};
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

  test("AUTH-035-B: the list, details, and activity name the owner and each actor, and scope=mine lists only the caller's own artifacts over HTTP and MCP", async () => {
    const adaPage = await publishAs(ada, "Ada's page");
    const benPage = await publishAs(ben, "Ben's page");
    await publishAs(bot, "Bot page");
    const retagged = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${adaPage.id}/tags`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: adaPage.currentVersionId,
          tags: ["reviewed"],
        }),
        headers: headersFor(ben, {idempotent: true, json: true}),
        method: "PATCH",
      },
    );
    expect(retagged.status).toBe(200);

    const listed = await listOverHttp(ben, "");
    expect(Object.fromEntries(listed.artifacts.map((entry) => [
      entry.artifact.name,
      entry.ownerDisplayName,
    ]))).toEqual({
      "Ada's page": "Ada Lovelace",
      "Ben's page": "Ben Beispiel",
      "Bot page": "Release bot",
    });

    const details = detailsSchema.parse(await (await fetch(
      `${server.baseUrl}/api/v1/artifacts/${adaPage.id}`,
      {headers: headersFor(ben)},
    )).json());
    expect(details.ownerDisplayName).toBe("Ada Lovelace");

    const actions = actionsSchema.parse(await (await fetch(
      `${server.baseUrl}/api/v1/artifacts/${adaPage.id}/actions`,
      {headers: headersFor(ben)},
    )).json());
    expect(actions.actions.map(({action, actorDisplayName}) => [action, actorDisplayName]))
      .toEqual(expect.arrayContaining([
        [expect.stringMatching(/publish/u), "Ada Lovelace"],
        [expect.stringMatching(/tag/u), "Ben Beispiel"],
      ]));

    expect((await listOverHttp(ben, "?scope=mine")).artifacts.map(({artifact}) => artifact.id))
      .toEqual([benPage.id]);
    expect((await listOverHttp(ada, "?scope=mine")).artifacts.map(({artifact}) => artifact.id))
      .toEqual([adaPage.id]);

    const mcpAll = mcpListSchema.parse(await callTool(ben, "artifact_list", {}));
    expect(Object.fromEntries(mcpAll.artifacts.map(({name, ownerDisplayName}) => [
      name,
      ownerDisplayName,
    ]))).toEqual({
      "Ada's page": "Ada Lovelace",
      "Ben's page": "Ben Beispiel",
      "Bot page": "Release bot",
    });
    const mcpMine = mcpListSchema.parse(await callTool(ben, "artifact_list", {scope: "mine"}));
    expect(mcpMine.artifacts.map(({name}) => name)).toEqual(["Ben's page"]);
    const mcpGet = mcpGetSchema.parse(
      await callTool(ben, "artifact_get", {artifactId: adaPage.id}),
    );
    expect(mcpGet.ownerDisplayName).toBe("Ada Lovelace");
  });

  test("AUTH-035-F: names never reveal email addresses, survive deactivation, scope=mine never widens other filters, and an unknown scope is refused", async () => {
    const adaPage = await publishAs(ada, "Ada's tagged page", ["team"]);
    await publishAs(ben, "Ben's tagged page", ["team"]);
    await publishAs(ben, "Ben's other page");

    const responses = await Promise.all([
      fetch(`${server.baseUrl}/api/v1/artifacts`, {headers: headersFor(ben)}),
      fetch(`${server.baseUrl}/api/v1/artifacts/${adaPage.id}`, {headers: headersFor(ben)}),
      fetch(`${server.baseUrl}/api/v1/artifacts/${adaPage.id}/actions`, {headers: headersFor(ben)}),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    for (const body of bodies) expect(body).not.toContain("@example.test");
    expect(JSON.stringify(await callTool(ben, "artifact_list", {}))).not.toContain("@example.test");

    const deactivated = await fetch(
      `${server.baseUrl}/api/v1/members/${ada.memberId}/deactivate`,
      {headers: browserMutationHeaders(), method: "POST"},
    );
    expect(deactivated.status).toBe(200);
    const afterDeactivation = await listOverHttp(ben, "?tag=team");
    expect(afterDeactivation.artifacts.find(({artifact}) => artifact.id === adaPage.id)
      ?.ownerDisplayName).toBe("Ada Lovelace");

    expect((await listOverHttp(ben, "?scope=mine&tag=team")).artifacts
      .map(({artifact}) => artifact.name)).toEqual(["Ben's tagged page"]);
    expect((await listOverHttp(ben, "?scope=mine&search=other")).artifacts
      .map(({artifact}) => artifact.name)).toEqual(["Ben's other page"]);

    const unknown = await fetch(`${server.baseUrl}/api/v1/artifacts?scope=everyone`, {
      headers: headersFor(ben),
    });
    expect(unknown.status).toBe(422);
    expect(errorSchema.parse(await unknown.json()).error.code).toBe("INVALID_INPUT");
    const refused = await callToolResult(ben, "artifact_list", {scope: "everyone"});
    expect(refused.isError).toBe(true);
  });

  async function memberWithKey(
    displayName: string,
    email: string,
  ): Promise<Actor & {readonly memberId: string}> {
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName, email}),
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(admitted.status).toBe(201);
    const memberId = memberSchema.parse(await admitted.json()).member.id;
    return {...await issueKey(memberId, `${displayName}'s key`), memberId};
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

  async function publishAs(actor: Actor, name: string, tags: readonly string[] = []) {
    const published = await publishNew(server, {...installation, apiToken: actor.token}, {
      accessSetting: "account_required",
      content: name,
      idempotencyKey: `publish-${name}-${actor.id}`,
      name,
      tags,
    });
    expect(published.response.status).toBe(201);
    return artifactSchema.parse(published.body.artifact);
  }

  async function listOverHttp(actor: Actor, query: string) {
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts${query}`, {
      headers: headersFor(actor),
    });
    expect(response.status).toBe(200);
    return listSchema.parse(await response.json());
  }

  async function callTool(actor: Actor, name: string, toolArguments: McpParameters) {
    const result = await callToolResult(actor, name, toolArguments);
    if (result.isError === true) {
      throw new Error(`${name} failed: ${result.content[0]?.text ?? "no message"}`);
    }
    return result.structuredContent;
  }

  async function callToolResult(actor: Actor, name: string, toolArguments: McpParameters) {
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

  function browserMutationHeaders(): Headers {
    return new Headers({
      "Content-Type": "application/json",
      Cookie: administrator.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": administrator.csrf,
    });
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
