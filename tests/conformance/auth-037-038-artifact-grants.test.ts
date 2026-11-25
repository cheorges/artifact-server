import path from "node:path";
import {DatabaseSync} from "node:sqlite";

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

const allCapabilities = [
  "agent:connect",
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
  "content-session:issue",
] as const;

const artifactSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link", "restricted"]),
  currentVersionId: z.string(),
  id: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string().nullable(),
  projectId: z.string(),
});
const artifactEnvelopeSchema = z.object({artifact: artifactSchema});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({artifact: artifactSchema})),
});
const memberSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({
  apiKey: z.object({principalId: z.string()}),
  token: z.string().startsWith("as_key_"),
});
const threadSchema = z.object({thread: z.object({id: z.string()})});
const agentSchema = z.object({agent: z.object({id: z.string()})});
const errorSchema = z.object({error: z.object({code: z.string()})});
const activitySchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    actorDisplayName: z.string().nullable(),
    authorizedByPrincipalId: z.string().nullable(),
    grantee: z.string().nullable(),
  })),
  nextCursor: z.string().nullable(),
});
const grantListSchema = z.object({
  active: z.boolean(),
  grants: z.array(z.object({
    grantedAt: z.string(),
    grantedByPrincipalId: z.string(),
    grantee: z.string(),
    kind: z.literal("email"),
  })),
});

const toolResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});
const mcpListSchema = z.object({artifacts: z.array(z.object({name: z.string()}))});
const mcpGetSchema = z.object({
  artifact: z.object({accessSetting: z.string(), name: z.string()}),
  grants: grantListSchema.nullable(),
});

/** Tool arguments these tests send: strings, string lists, and nulls. */
type McpArguments = Readonly<Record<string, string | readonly string[] | null>>;

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** A caller that authenticates with an API key. */
interface Actor {
  readonly id: string;
  readonly token: string;
}

/** The local-owner administrator, signed in through a browser session. */
interface BrowserActor {
  readonly cookies: ApplicationCookies;
  readonly id: string;
}

type Caller = Actor | BrowserActor;

/** The administrator's request to issue one API key. */
interface IssueKeyRequest {
  readonly capabilities: readonly string[];
  readonly expiresAt: string;
  readonly memberId?: string;
  readonly name: string;
}

/** Request bodies sent by these tests: strings and string lists only. */
type RequestBody = Readonly<Record<string, string | readonly string[]>>;

/** The sharing rows of one activity page, in a stable order: one save shares one time. */
function sharingRows(page: z.infer<typeof activitySchema>) {
  return page.actions
    .filter(({grantee}) => grantee !== null)
    .toSorted((left, right) =>
      `${left.action} ${left.grantee ?? ""}`.localeCompare(`${right.action} ${right.grantee ?? ""}`));
}

describe("grants to persons on restricted artifacts", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let administrator: ApplicationCookies;
  let ada: Actor;
  let ben: Actor;
  let service: Actor;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    administrator = await signInAdministrator(server, installation);
    ada = await memberWithKey("Ada", "ada@example.test");
    ben = await memberWithKey("Ben", "ben@example.test");
    service = await issueKey(undefined, "Release bot");
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-037-B: a member granted by email finds, reads, opens, compares, and comments on a restricted artifact and lists it as shared with them", async () => {
    expect.hasAssertions();
    const draft = await publishAs(ada, "Ada's plan", "restricted");
    await publishAs(ada, "Ada's open page");
    await publishAs(ben, "Ben's own page", "restricted");
    const granted = await grant(ada, draft.id, [" BEN@example.test "]);
    expect(granted.status).toBe(200);

    expect(await listedNames(ben)).toContain("Ada's plan");
    expect(await listedNames(ben, "plan")).toStrictEqual(["Ada's plan"]);
    expect((await readArtifact(ben, draft.id)).accessSetting).toBe("restricted");
    expect((await request(ben, "GET", `${draft.id}/versions`)).status).toBe(200);
    expect((await request(ben, "POST", `${draft.id}/content-sessions`)).status).toBe(201);
    const next = await publishVersion(server, as(ada), {
      artifactId: draft.id,
      content: "Ada's second plan",
      expectedCurrentVersionId: draft.currentVersionId,
      idempotencyKey: "auth-037-ada-version",
      projectId: draft.projectId,
    });
    expect(next.response.status).toBe(201);
    const compared = await request(
      ben,
      "GET",
      `${draft.id}/comparisons?fromVersionId=${draft.currentVersionId}&toVersionId=${next.body.version.id}`,
    );
    expect(compared.status).toBe(200);
    await commentOn(ben, draft.id, next.body.version.id);
    expect((await request(ben, "GET", `${draft.id}/comments`)).status).toBe(200);

    expect(await listedNames(ben, undefined, "shared_with_me")).toStrictEqual(["Ada's plan"]);
    expect(await listedNames(ada, undefined, "shared_with_me")).toStrictEqual([]);
    const listedOverMcp = mcpListSchema.parse(await callTool(ben, "artifact_list", {scope: "shared_with_me"}));
    expect(listedOverMcp.artifacts.map(({name}) => name)).toStrictEqual(["Ada's plan"]);
    const readOverMcp = mcpGetSchema.parse(await callTool(ben, "artifact_get", {artifactId: draft.id}));
    expect(readOverMcp.artifact.accessSetting).toBe("restricted");
    // A grantee never sees who else the artifact is shared with.
    expect(readOverMcp.grants).toBeNull();

    // A grant for someone who is not a member yet applies once they are admitted.
    expect((await grant(ada, draft.id, ["dora@example.test"])).status).toBe(200);
    const dora = await memberWithKey("Dora", "dora@example.test");
    expect(await listedNames(dora, undefined, "shared_with_me")).toStrictEqual(["Ada's plan"]);
    expect((await readArtifact(dora, draft.id)).name).toBe("Ada's plan");
  });

  test("AUTH-037-F: grantees cannot manage or remove others' comments, others cannot see, a deactivated grantee or one whose recorded email differs loses access, and grants on other settings change nothing", async () => {
    expect.hasAssertions();
    const draft = await publishAs(ada, "Ada's secret", "restricted");
    expect((await grant(ada, draft.id, ["ben@example.test"])).status).toBe(200);
    const carl = await memberWithKey("Carl", "carl@example.test");
    const missing = await request(carl, "GET", "art_00000000-0000-4000-8000-000000000000");
    expect((await request(carl, "GET", draft.id)).status).toBe(missing.status);
    expect((await request(service, "GET", draft.id)).status).toBe(missing.status);
    expect(await listedNames(carl)).not.toContain("Ada's secret");
    expect(await listedNames(service)).not.toContain("Ada's secret");

    const refusals = await Promise.all([
      mutate(ben, "PATCH", `${draft.id}/tags`, {
        expectedCurrentVersionId: draft.currentVersionId,
        tags: ["grantee"],
      }),
      mutate(ben, "PATCH", `${draft.id}/access`, {
        accessSetting: "account_required",
        expectedCurrentVersionId: draft.currentVersionId,
      }),
      mutate(ben, "POST", `${draft.id}/restore`, {
        expectedCurrentVersionId: draft.currentVersionId,
        versionId: draft.currentVersionId,
      }),
      mutate(ben, "DELETE", draft.id, {expectedCurrentVersionId: draft.currentVersionId}),
      grant(ben, draft.id, ["carl@example.test"]),
      request(ben, "GET", `${draft.id}/grants`),
    ]);
    expect(refusals.map(({status}) => status)).toStrictEqual(refusals.map(() => 403));
    // The refusal names what the grantee lacks, whatever they tried to change.
    expect(await refusals[0]?.text()).toContain("Only the owner or an administrator can manage this artifact.");
    const refusedOverMcp = await callToolResult(ben, "artifact_set_grants", {
      add: ["carl@example.test"],
      artifactId: draft.id,
    });
    expect(refusedOverMcp.isError).toBe(true);
    expect(refusedOverMcp.content[0]?.text).toContain("Only the owner or an administrator");
    await expect(publishVersion(server, as(ben), {
      artifactId: draft.id,
      content: "grantee version",
      expectedCurrentVersionId: draft.currentVersionId,
      idempotencyKey: "auth-037-grantee-version",
      projectId: draft.projectId,
    })).rejects.toThrow("can manage this artifact");
    const thread = await commentOn(ben, draft.id, draft.currentVersionId);

    // Commenting is shared; removing someone else's review is not.
    const adasThread = await commentOn(ada, draft.id, draft.currentVersionId);
    expect((await request(ben, "DELETE", `${draft.id}/comments/${adasThread}`)).status).toBe(403);
    const cleared = await fetch(
      `${server.baseUrl}/api/v1/projects/${draft.projectId}/artifacts/${draft.id}/comments/clear`,
      {body: JSON.stringify({state: "all"}), headers: headersFor(ben, {json: true}), method: "POST"},
    );
    expect(cleared.status).toBe(403);
    expect((await request(ada, "GET", `${draft.id}/comments/${adasThread}`)).status).toBe(200);
    expect((await request(ben, "DELETE", `${draft.id}/comments/${thread}`)).status).toBe(204);

    const agent = await registerAgent(service);
    const dispatched = await dispatch(ben, agent, [adasThread]);
    expect(dispatched.status).toBeGreaterThanOrEqual(400);
    expect(dispatched.status).toBeLessThan(500);
    expect((await readArtifact(ada, draft.id)).accessSetting).toBe("restricted");

    // A grant on an artifact every member sees changes nothing for anyone.
    const open = await publishAs(ada, "Ada's open page");
    expect((await grant(ada, open.id, ["carl@example.test"])).status).toBe(200);
    expect(await listedNames(carl, undefined, "shared_with_me")).toStrictEqual([]);
    expect((await readArtifact(service, open.id)).name).toBe("Ada's open page");
    // A service principal is never granted anything, so nothing is shared with it.
    expect(await listedNames(service)).toContain("Ada's open page");
    expect(await listedNames(service, undefined, "shared_with_me")).toStrictEqual([]);

    // The grant follows the email Artifact Server records for the member.
    const database = openDatabase();
    try {
      database.prepare("UPDATE installation_members SET email = 'ben@elsewhere.test' WHERE id = ?").run(ben.id);
      expect((await request(ben, "GET", draft.id)).status).toBe(missing.status);
      database.prepare("UPDATE installation_members SET email = 'ben@example.test' WHERE id = ?").run(ben.id);
      expect((await request(ben, "GET", draft.id)).status).toBe(200);
    } finally {
      database.close();
    }
    const deactivated = await fetch(`${server.baseUrl}/api/v1/members/${ben.id}/deactivate`, {
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(deactivated.status).toBe(200);
    expect((await request(ben, "GET", draft.id)).status).toBe(401);
  });

  test("AUTH-038-B: the owner and an administrator manage grants, repeated adds are no-ops, and the list survives switching away and back", async () => {
    expect.hasAssertions();
    const draft = await publishAs(ada, "Ada's review", "restricted");
    const added = await grant(ada, draft.id, ["ben@example.test", "Ben@Example.test"]);
    expect(added.status).toBe(200);
    expect(grantListSchema.parse(await added.json())).toMatchObject({
      active: true,
      grants: [{grantedByPrincipalId: ada.id, grantee: "ben@example.test", kind: "email"}],
    });
    expect((await grant(administratorActor(), draft.id, ["dora@example.test", "ben@example.test"])).status)
      .toBe(200);
    const sharedOverMcp = grantListSchema.parse(await callTool(ada, "artifact_set_grants", {
      add: ["erin@example.test"],
      artifactId: draft.id,
      remove: [],
    }));
    expect(sharedOverMcp.grants.map(({grantee}) => grantee))
      .toStrictEqual(["ben@example.test", "dora@example.test", "erin@example.test"]);
    expect(grantListSchema.parse(await callTool(ada, "artifact_set_grants", {
      artifactId: draft.id,
      remove: ["Erin@example.test"],
    })).grants.map(({grantee}) => grantee)).toStrictEqual(["ben@example.test", "dora@example.test"]);
    const listed = grantListSchema.parse(await (await request(ada, "GET", `${draft.id}/grants`)).json());
    expect(listed.grants.map(({grantee}) => grantee)).toStrictEqual(["ben@example.test", "dora@example.test"]);
    expect(mcpGetSchema.parse(await callTool(ada, "artifact_get", {artifactId: draft.id})).grants)
      .toStrictEqual(listed);
    expect(grantListSchema.parse(await (await request(administratorActor(), "GET", `${draft.id}/grants`)).json()))
      .toStrictEqual(listed);

    expect((await request(ben, "POST", `${draft.id}/content-sessions`)).status).toBe(201);
    expect((await request(administratorActor(), "POST", `${draft.id}/content-sessions`)).status).toBe(201);
    expect((await mutate(ada, "PATCH", `${draft.id}/access`, {
      accessSetting: "account_required",
      expectedCurrentVersionId: draft.currentVersionId,
    })).status).toBe(200);
    expect(grantListSchema.parse(await (await request(ada, "GET", `${draft.id}/grants`)).json()))
      .toStrictEqual({...listed, active: false});
    const carl = await memberWithKey("Carl", "carl@example.test");
    expect((await request(carl, "POST", `${draft.id}/content-sessions`)).status).toBe(201);

    // Switching back restores the list and keeps the grantee's content access
    // while ending a plain member's and an administrator's: an administrator's
    // content may come from a member-bound key, so they open it again.
    expect((await mutate(ada, "PATCH", `${draft.id}/access`, {
      accessSetting: "restricted",
      expectedCurrentVersionId: draft.currentVersionId,
    })).status).toBe(200);
    expect(grantListSchema.parse(await (await request(ada, "GET", `${draft.id}/grants`)).json()))
      .toStrictEqual(listed);
    expect(await listedNames(ben)).toContain("Ada's review");
    expect(openContentAccess(draft.id, ben.id)).toBeGreaterThan(0);
    expect(openContentAccess(draft.id, administratorMemberId())).toBe(0);
    expect(openContentAccess(draft.id, carl.id)).toBe(0);
  });

  test("AUTH-038-F: grant changes are refused for others, malformed, contradictory, or too large, and removing a grant ends access at once", async () => {
    expect.hasAssertions();
    const draft = await publishAs(ada, "Ada's limits", "restricted");
    expect((await grant(ada, draft.id, ["ben@example.test"])).status).toBe(200);
    const carl = await memberWithKey("Carl", "carl@example.test");
    const missing = await request(carl, "GET", "art_00000000-0000-4000-8000-000000000000");
    expect((await grant(carl, draft.id, ["carl@example.test"])).status).toBe(missing.status);
    expect((await request(carl, "GET", `${draft.id}/grants`)).status).toBe(missing.status);
    expect((await grant(service, draft.id, ["bot@example.test"])).status).toBe(missing.status);

    // A key of the owner's without the management capability cannot share.
    const readingKey = await issueKey(ada.id, "Ada's reading key", ["artifact:read"]);
    expect((await grant(readingKey, draft.id, ["dora@example.test"])).status).toBe(403);
    expect((await request(readingKey, "GET", `${draft.id}/grants`)).status).toBe(403);
    // That key still reads the artifact over MCP; only the grant list is withheld.
    const readByNarrowKey = mcpGetSchema.parse(await callTool(readingKey, "artifact_get", {artifactId: draft.id}));
    expect(readByNarrowKey.artifact.name).toBe("Ada's limits");
    expect(readByNarrowKey.grants).toBeNull();

    // On an artifact every member sees, other members get 403, not the list.
    const open = await publishAs(ada, "Ada's open limits");
    expect((await request(carl, "GET", `${open.id}/grants`)).status).toBe(403);
    expect((await grant(carl, open.id, ["carl@example.test"])).status).toBe(403);

    const malformed = await grant(ada, draft.id, ["not-an-address"]);
    expect(malformed.status).toBe(422);
    expect(errorSchema.parse(await malformed.json()).error.code).toBe("INVALID_INPUT");
    expect((await grant(ada, draft.id, ["x@example.test"], ["X@example.test"])).status).toBe(422);
    const tooMany = await grant(
      ada,
      draft.id,
      Array.from({length: 100}, (_, index) => `person${index}@example.test`),
    );
    expect(tooMany.status).toBe(409);
    expect(errorSchema.parse(await tooMany.json()).error.code).toBe("GRANT_LIMIT_REACHED");
    const unchanged = grantListSchema.parse(await (await request(ada, "GET", `${draft.id}/grants`)).json());
    expect(unchanged.grants.map(({grantee}) => grantee)).toStrictEqual(["ben@example.test"]);

    expect((await request(ben, "POST", `${draft.id}/content-sessions`)).status).toBe(201);
    expect(openContentAccess(draft.id, ben.id)).toBeGreaterThan(0);
    expect((await grant(ada, draft.id, [], ["ben@example.test"])).status).toBe(200);
    expect(openContentAccess(draft.id, ben.id)).toBe(0);
    expect((await request(ben, "GET", draft.id)).status).toBe(missing.status);
    expect(await listedNames(ben, undefined, "shared_with_me")).toStrictEqual([]);

    // Deleting the artifact removes the addresses it was shared with.
    expect((await grant(ada, draft.id, ["dora@example.test"])).status).toBe(200);
    expect((await mutate(ada, "DELETE", draft.id, {expectedCurrentVersionId: draft.currentVersionId})).status)
      .toBe(200);
    const database = openDatabase();
    try {
      expect(z.object({total: z.number()}).parse(database.prepare(
        "SELECT COUNT(*) AS total FROM artifact_grants WHERE artifact_id = ?",
      ).get(draft.id)).total).toBe(0);
    } finally {
      database.close();
    }
  });

  test("AUTH-039-B: adding and removing people records one row per person for the owner and administrators, from HTTP and MCP, also after deletion", async () => {
    expect.hasAssertions();
    const draft = await publishAs(ada, "Ada's shared notes", "restricted");
    expect((await grant(ada, draft.id, ["ben@example.test"])).status).toBe(200);
    await callTool(ada, "artifact_set_grants", {
      add: ["dora@example.test"],
      artifactId: draft.id,
      remove: ["ben@example.test"],
    });
    // Ada acts through a member-bound key, so each row also names the
    // administrator who issued it, as access changes do.
    const issuer = administratorMemberId();
    const expected = [
      {action: "grant_add", actorDisplayName: "Ada", authorizedByPrincipalId: issuer, grantee: "ben@example.test"},
      {action: "grant_add", actorDisplayName: "Ada", authorizedByPrincipalId: issuer, grantee: "dora@example.test"},
      {action: "grant_remove", actorDisplayName: "Ada", authorizedByPrincipalId: issuer, grantee: "ben@example.test"},
    ];
    expect(sharingRows(await activity(ada, draft.id))).toStrictEqual(expected);
    expect(sharingRows(await activity(administratorActor(), draft.id))).toStrictEqual(expected);

    expect((await mutate(ada, "DELETE", draft.id, {
      expectedCurrentVersionId: draft.currentVersionId,
    })).status).toBe(200);
    expect(sharingRows(await activity(ada, draft.id))).toStrictEqual(expected);
    expect(sharingRows(await activity(administratorActor(), draft.id))).toStrictEqual(expected);
  });

  test("AUTH-039-F: repeated and refused changes write nothing, and nobody else sees sharing rows", async () => {
    expect.hasAssertions();
    const draft = await publishAs(ada, "Ada's quiet page", "restricted");
    expect((await grant(ada, draft.id, ["ben@example.test"])).status).toBe(200);
    const sharingCount = async () => sharingRows(await activity(ada, draft.id)).length;
    expect(await sharingCount()).toBe(1);
    expect((await grant(ada, draft.id, ["ben@example.test"])).status).toBe(200);
    expect((await grant(ada, draft.id, [], ["nobody@example.test"])).status).toBe(200);
    expect((await grant(ada, draft.id, ["not-an-address"])).status).toBe(422);
    expect((await grant(ada, draft.id, ["x@example.test"], ["x@example.test"])).status).toBe(422);
    expect((await grant(
      ada,
      draft.id,
      Array.from({length: 100}, (_, index) => `person${index}@example.test`),
    )).status).toBe(409);
    expect(await sharingCount()).toBe(1);

    // The grantee pages past every sharing row to the publish row.
    expect((await grant(ada, draft.id, ["carol@example.test", "dan@example.test"])).status).toBe(200);
    expect(await sharingCount()).toBe(3);
    const firstPage = await activity(ben, draft.id, 1);
    expect(firstPage.actions.map(({action, grantee}) => ({action, grantee})))
      .toStrictEqual([{action: "publish", grantee: null}]);
    expect(firstPage.nextCursor).toBeNull();

    // On a page every member sees, only the owner sees who it is shared with.
    const open = await publishAs(ada, "Ada's open page");
    expect((await grant(ada, open.id, ["erin@example.test"])).status).toBe(200);
    expect(sharingRows(await activity(ada, open.id)).map(({grantee}) => grantee))
      .toStrictEqual(["erin@example.test"]);
    const carl = await memberWithKey("Carl", "carl@example.test");
    const administratorKey = await issueKey(
      administratorMemberId(),
      "Administrator's key",
      ["artifact:read", "artifact:manage:any"],
    );
    const othersSee = await Promise.all([carl, administratorKey].map(async (viewer) =>
      sharingRows(await activity(viewer, open.id))));
    expect(othersSee).toStrictEqual([[], []]);
  });

  async function callTool(actor: Actor, name: string, toolArguments: McpArguments) {
    const result = await callToolResult(actor, name, toolArguments);
    if (result.isError === true) {
      throw new Error(`${name} failed: ${result.content[0]?.text ?? "no message"}`);
    }
    return result.structuredContent;
  }

  async function callToolResult(actor: Actor, name: string, toolArguments: McpArguments) {
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

  async function activity(actor: Caller, artifactId: string, limit = 100) {
    const response = await request(actor, "GET", `${artifactId}/actions?limit=${limit}`);
    expect(response.status).toBe(200);
    return activitySchema.parse(await response.json());
  }

  function grant(
    actor: Caller,
    artifactId: string,
    add: readonly string[],
    remove: readonly string[] = [],
  ): Promise<Response> {
    return mutate(actor, "PATCH", `${artifactId}/grants`, {add, remove});
  }

  function administratorActor(): BrowserActor {
    return {cookies: administrator, id: "administrator"};
  }

  function as(actor: Actor): TestInstallation {
    return {...installation, apiToken: actor.token};
  }

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

  async function issueKey(
    memberId: string | undefined,
    name: string,
    capabilities: readonly string[] = allCapabilities,
  ): Promise<Actor> {
    const keyRequest: IssueKeyRequest = {
      capabilities: [...capabilities],
      expiresAt: "2099-01-01T00:00:00.000Z",
      name,
    };
    const body: IssueKeyRequest = memberId === undefined
      ? keyRequest
      : {...keyRequest, memberId};
    const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify(body),
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(response.status).toBe(201);
    const issued = issuedKeySchema.parse(await response.json());
    return {id: issued.apiKey.principalId, token: issued.token};
  }

  async function publishAs(
    actor: Actor,
    name: string,
    accessSetting: "account_required" | "restricted" = "account_required",
  ): Promise<z.infer<typeof artifactSchema>> {
    const published = await publishNew(server, as(actor), {
      accessSetting,
      content: name,
      idempotencyKey: `publish-${name}-${actor.id}`,
      name,
    });
    expect(published.response.status).toBe(201);
    return artifactSchema.parse(published.body.artifact);
  }

  async function readArtifact(actor: Caller, artifactId: string) {
    const response = await request(actor, "GET", artifactId);
    expect(response.status).toBe(200);
    return artifactEnvelopeSchema.parse(await response.json()).artifact;
  }

  async function listedNames(
    actor: Caller,
    search?: string,
    scope?: "shared_with_me",
  ): Promise<string[]> {
    const parameters = new URLSearchParams();
    if (search !== undefined) parameters.set("search", search);
    if (scope !== undefined) parameters.set("scope", scope);
    const query = parameters.size === 0 ? "" : `?${parameters.toString()}`;
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts${query}`, {
      headers: headersFor(actor),
    });
    expect(response.status).toBe(200);
    return artifactPageSchema.parse(await response.json()).artifacts
      .map(({artifact}) => artifact.name);
  }

  async function commentOn(
    actor: Caller,
    artifactId: string,
    versionId: string,
  ): Promise<string> {
    const response = await mutate(
      actor,
      "POST",
      `${artifactId}/versions/${versionId}/comments`,
      {body: "Please check this."},
    );
    expect(response.status).toBe(201);
    return threadSchema.parse(await response.json()).thread.id;
  }

  async function registerAgent(actor: Actor): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/agents`, {
      body: JSON.stringify({
        displayName: "Test agent",
        kind: "pi",
        workingDirectory: "/tmp/agent",
      }),
      headers: headersFor(actor, {json: true}),
      method: "POST",
    });
    expect(response.status).toBeLessThan(300);
    return agentSchema.parse(await response.json()).agent.id;
  }

  function dispatch(
    actor: Actor,
    agentId: string,
    threadIds: readonly string[],
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/agent-dispatches`, {
      body: JSON.stringify({agentId, threadIds}),
      headers: headersFor(actor, {idempotent: true, json: true}),
      method: "POST",
    });
  }

  function request(actor: Caller, method: string, artifactPath: string): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactPath}`, {
      headers: headersFor(actor),
      method,
    });
  }

  function mutate(
    actor: Caller,
    method: string,
    artifactPath: string,
    body: RequestBody,
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactPath}`, {
      body: JSON.stringify(body),
      headers: headersFor(actor, {idempotent: true, json: true}),
      method,
    });
  }

  function headersFor(
    actor: Caller,
    options: {readonly idempotent?: boolean; readonly json?: boolean} = {},
  ): Headers {
    const headers = "cookies" in actor
      ? new Headers({
        Cookie: actor.cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": actor.cookies.csrf,
      })
      : new Headers({Authorization: `Bearer ${actor.token}`});
    if (options.json === true) headers.set("Content-Type", "application/json");
    if (options.idempotent === true) {
      headers.set("Idempotency-Key", crypto.randomUUID());
    }
    return headers;
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

  function openContentAccess(artifactId: string, principalId: string): number {
    const database = openDatabase();
    try {
      const count = z.object({total: z.number()});
      return ["content_sessions", "content_bootstraps"].reduce(
        (total, table) => total + count.parse(database.prepare(
          `SELECT COUNT(*) AS total FROM ${table}
           WHERE artifact_id = ? AND principal_id = ?`,
        ).get(artifactId, principalId)).total,
        0,
      );
    } finally {
      database.close();
    }
  }

  function administratorMemberId(): string {
    const database = openDatabase();
    try {
      return z.object({id: z.string()}).parse(database.prepare(
        "SELECT id FROM installation_members WHERE role = 'administrator' LIMIT 1",
      ).get()).id;
    } finally {
      database.close();
    }
  }

  function openDatabase(): DatabaseSync {
    return new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
  }
});
