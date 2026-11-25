/**
 * Sharing restricted artifacts with directory groups (decision 0034):
 * AUTH-040 (who gets what, and what a directory failure does) and AUTH-041
 * (group search), through HTTP and MCP against the local SQLite server with
 * an in-memory directory.
 */

import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  groupLookupBackoffMilliseconds,
  groupMembershipCacheMilliseconds,
} from "../../src/core/group-directory.js";
import {signInAdministrator} from "../support/agent-dispatch.js";
import {createFakeGroupDirectory, type FakeGroupDirectory} from "../support/fake-group-directory.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const identityProvider = "oidc:https://issuer.example.test";

const allCapabilities = [
  "agent:connect",
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
  "content-session:issue",
] as const;

const dep = {id: "11111111-1111-4111-8111-111111111111", name: "Developer Productivity"};
const guild = {id: "22222222-2222-4222-8222-222222222222", name: "Architecture Guild"};
const platform = {id: "33333333-3333-4333-8333-333333333333", name: "Platform Chapter"};

const artifactSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link", "restricted"]),
  currentVersionId: z.string(),
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
});
const artifactPageSchema = z.object({artifacts: z.array(z.object({artifact: artifactSchema}))});
const memberSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({
  apiKey: z.object({principalId: z.string()}),
  token: z.string().startsWith("as_key_"),
});
const errorSchema = z.object({error: z.object({code: z.string()})});
const activitySchema = z.object({
  actions: z.array(z.object({action: z.string(), grantee: z.string().nullable()}).loose()),
});
const grantListSchema = z.object({
  active: z.boolean(),
  grants: z.array(z.object({
    displayName: z.string().nullable(),
    grantedAt: z.string(),
    grantedByPrincipalId: z.string(),
    grantee: z.string(),
    kind: z.enum(["email", "group"]),
  }).strict()),
}).strict();
const groupSearchSchema = z.object({
  groups: z.array(z.object({
    displayName: z.string(),
    id: z.string(),
    mail: z.string().nullable(),
  }).strict()),
}).strict();
const sessionSchema = z.object({capabilities: z.object({groupSharing: z.boolean()}).loose()}).loose();
const toolResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).loose(),
});
const mcpGetSchema = z.object({grants: grantListSchema.nullable()}).loose();
const mcpListSchema = z.object({artifacts: z.array(z.object({name: z.string()}).loose())}).loose();

interface GroupReference {
  readonly id: string;
  readonly name: string;
}

interface GrantChange {
  readonly add?: readonly string[];
  readonly addGroups?: readonly GroupReference[];
  readonly remove?: readonly string[];
  readonly removeGroups?: readonly GroupReference[];
}

type McpArguments = Readonly<Record<string, string | readonly string[] | readonly GroupReference[]>>;

/** A member or service principal that authenticates with an API key. */
interface Actor {
  readonly id: string;
  readonly token: string;
}

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** The group sharing rows of one activity page, in a stable order. */
function groupRows(page: z.infer<typeof activitySchema>) {
  return page.actions
    .filter(({action}) => action.startsWith("grant_group_"))
    .map(({action, grantee}) => ({action, grantee}))
    .toSorted((left, right) => `${left.action} ${left.grantee ?? ""}`.localeCompare(`${right.action} ${right.grantee ?? ""}`));
}

function headersFor(actor: Actor): Headers {
  return new Headers({Authorization: `Bearer ${actor.token}`});
}

describe("grants to directory groups on restricted artifacts", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let administrator: ApplicationCookies;
  let directory: FakeGroupDirectory;
  let now: number;
  let ada: Actor;
  let ben: Actor;
  let cara: Actor;
  let erin: Actor;
  let service: Actor;

  beforeEach(async () => {
    installation = await createTestInstallation();
    directory = createFakeGroupDirectory();
    now = Date.now();
    server = await startTestServer(installation, {
      clock: {now: () => new Date(now)},
      groupSharing: {directory, identityProvider},
    });
    administrator = await signInAdministrator(server, installation);
    ada = await memberWithKey("Ada", "ada@example.test", "oid-ada");
    ben = await memberWithKey("Ben", "ben@example.test", "oid-ben");
    cara = await memberWithKey("Cara", "cara@example.test", "oid-cara");
    erin = await memberWithKey("Erin", "erin@example.test", "oid-erin");
    service = await issueKey(undefined, "Release bot");
    directory.addGroup({displayName: dep.name, id: dep.id, mail: "dep@example.test"}, ["oid-ben"]);
    // Cara is a member through a nested group: the directory reports her like a direct member.
    directory.addGroup({displayName: guild.name, id: guild.id, mail: null}, ["oid-cara"]);
    directory.addGroup({displayName: platform.name, id: platform.id, mail: "platform@example.test"}, []);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-040-B: the owner shares with groups over HTTP and MCP, and direct and nested members find, open, and comment", async () => {
    expect.hasAssertions();
    const draft = await publishAs(ada, "Ada's team plan", "restricted");
    const next = await publishVersion(server, as(ada), {
      artifactId: draft.id,
      content: "Ada's second team plan",
      expectedCurrentVersionId: draft.currentVersionId,
      idempotencyKey: "auth-040-ada-version",
      projectId: draft.projectId,
    });
    expect(next.response.status).toBe(201);

    // Listing one's own artifacts never needs the directory.
    expect(await listedNames(ada, "mine")).toContain("Ada's team plan");
    expect(directory.calls.membership).toBe(0);

    const overHttp = await change(ada, draft.id, {addGroups: [dep]});
    expect(overHttp.status).toBe(200);
    const overMcp = grantListSchema.parse(await callTool(ada, "artifact_set_grants", {
      addGroups: [guild],
      artifactId: draft.id,
    }));
    expect(overMcp.grants.map(({displayName, grantee, kind}) => ({displayName, grantee, kind}))).toStrictEqual([
      {displayName: guild.name, grantee: guild.id, kind: "group"},
      {displayName: dep.name, grantee: dep.id, kind: "group"},
    ]);

    const openings = await Promise.all([ben, cara].map(async (member) => ({
      comment: (await mutate(member, "POST", `${draft.id}/versions/${next.body.version.id}/comments`, {body: "Looks right."})).status,
      content: (await request(member, "POST", `${draft.id}/content-sessions`)).status,
      listed: await listedNames(member, "shared_with_me"),
      older: (await request(member, "GET", `${draft.id}/versions/${draft.currentVersionId}`)).status,
      read: (await request(member, "GET", draft.id)).status,
      versions: (await request(member, "GET", `${draft.id}/versions`)).status,
    })));
    expect(openings).toStrictEqual([ben, cara].map(() => ({
      comment: 201, content: 201, listed: ["Ada's team plan"], older: 200, read: 200, versions: 200,
    })));
    const listedOverMcp = mcpListSchema.parse(await callTool(ben, "artifact_list", {scope: "shared_with_me"}));
    expect(listedOverMcp.artifacts.map(({name}) => name)).toStrictEqual(["Ada's team plan"]);
    expect(await listedNames(ada, "shared_with_me")).toStrictEqual([]);

    expect(groupRows(await activity(ada, draft.id))).toStrictEqual([
      {action: "grant_group_add", grantee: guild.name},
      {action: "grant_group_add", grantee: dep.name},
    ]);
    const readByOwner = mcpGetSchema.parse(await callTool(ada, "artifact_get", {artifactId: draft.id}));
    expect(readByOwner.grants?.grants.map(({displayName}) => displayName)).toStrictEqual([guild.name, dep.name]);
    // The membership was asked once per member, not per request.
    expect(directory.calls.membership).toBeLessThanOrEqual(3);

    const removed = await change(ada, draft.id, {removeGroups: [dep]});
    expect(grantListSchema.parse(await removed.json()).grants.map(({grantee}) => grantee)).toStrictEqual([guild.id]);
    expect(groupRows(await activity(ada, draft.id))).toContainEqual({action: "grant_group_remove", grantee: dep.name});
  });

  test("AUTH-040-F: members never manage or learn the groups, a failed lookup or a left group gives no access, and wrong, unknown, or unreachable groups change nothing", async () => {
    expect.hasAssertions();
    const draft = await publishAs(ada, "Ada's team secret", "restricted");
    expect((await change(ada, draft.id, {add: ["erin@example.test"], addGroups: [dep, guild]})).status).toBe(200);
    const missing = (await request(service, "GET", "art_00000000-0000-4000-8000-000000000000")).status;

    // Members of a granted group read and comment; they never manage.
    const refusals = await Promise.all([
      mutate(ben, "PATCH", `${draft.id}/tags`, {expectedCurrentVersionId: draft.currentVersionId, tags: ["member"]}),
      mutate(ben, "DELETE", draft.id, {expectedCurrentVersionId: draft.currentVersionId}),
      change(ben, draft.id, {addGroups: [platform]}),
      request(ben, "GET", `${draft.id}/grants`),
    ]);
    expect(refusals.map(({status}) => status)).toStrictEqual([403, 403, 403, 403]);
    await expect(publishVersion(server, as(ben), {
      artifactId: draft.id,
      content: "member version",
      expectedCurrentVersionId: draft.currentVersionId,
      idempotencyKey: "auth-040-member-version",
      projectId: draft.projectId,
    })).rejects.toThrow("can manage this artifact");

    // Nobody but the owner and administrators learns the groups.
    const carl = await memberWithKey("Carl", "carl@example.test", "oid-carl");
    expect((await request(carl, "GET", draft.id)).status).toBe(missing);
    expect((await request(service, "GET", draft.id)).status).toBe(missing);
    expect(await listedNames(carl)).not.toContain("Ada's team secret");
    const seenByMember = mcpGetSchema.parse(await callTool(ben, "artifact_get", {artifactId: draft.id}));
    expect(seenByMember.grants).toBeNull();
    expect(groupRows(await activity(ben, draft.id))).toStrictEqual([]);
    expect(groupRows(await activity(erin, draft.id))).toStrictEqual([]);

    // A failed lookup gives no access through groups, is not remembered, and leaves person grants alone.
    now += groupMembershipCacheMilliseconds;
    directory.failNext(1);
    expect((await request(ben, "GET", draft.id)).status).toBe(missing);
    expect(await listedNames(ben, "shared_with_me")).toStrictEqual([]);
    expect((await request(erin, "GET", draft.id)).status).toBe(200);
    expect(await listedNames(erin, "shared_with_me")).toStrictEqual(["Ada's team secret"]);
    // A failing directory is not asked again at once; after the pause Ben is back.
    const askedWhileFailing = directory.calls.membership;
    expect((await request(ben, "GET", draft.id)).status).toBe(missing);
    expect(directory.calls.membership).toBe(askedWhileFailing);
    now += groupLookupBackoffMilliseconds;
    expect((await request(ben, "GET", draft.id)).status).toBe(200);

    // Leaving the group ends access once the remembered membership expires.
    directory.setMembers(dep.id, []);
    expect((await request(ben, "GET", draft.id)).status).toBe(200);
    now += groupMembershipCacheMilliseconds;
    expect((await request(ben, "GET", draft.id)).status).toBe(missing);
    expect(await listedNames(ben, "shared_with_me")).toStrictEqual([]);

    // Removing a group ends its members' content sessions at once.
    expect((await request(cara, "POST", `${draft.id}/content-sessions`)).status).toBe(201);
    expect(openContentAccess(draft.id, cara.id)).toBeGreaterThan(0);
    expect((await change(ada, draft.id, {removeGroups: [guild]})).status).toBe(200);
    expect(openContentAccess(draft.id, cara.id)).toBe(0);

    // Repeated adds and removals of absent groups write no row.
    const rowsBefore = groupRows(await activity(ada, draft.id)).length;
    expect((await change(ada, draft.id, {addGroups: [dep], removeGroups: [guild]})).status).toBe(200);
    expect(groupRows(await activity(ada, draft.id))).toHaveLength(rowsBefore);

    // A wrong name, an unknown group, a group in both lists, and an unreachable directory refuse the change.
    const refused = async (changeBody: GrantChange) => {
      const response = await change(ada, draft.id, changeBody);
      return {code: errorSchema.parse(await response.json()).error.code, status: response.status};
    };
    expect(await refused({addGroups: [{id: platform.id, name: "Platform"}]}))
      .toStrictEqual({code: "GROUP_NAME_MISMATCH", status: 409});
    expect(await refused({removeGroups: [{id: dep.id, name: "Developers"}]}))
      .toStrictEqual({code: "GROUP_NAME_MISMATCH", status: 409});
    expect(await refused({addGroups: [{id: "44444444-4444-4444-8444-444444444444", name: "Nobody"}]}))
      .toStrictEqual({code: "GROUP_NOT_FOUND", status: 404});
    expect((await change(ada, draft.id, {addGroups: [platform], removeGroups: [platform]})).status).toBe(422);
    directory.failNext(1);
    expect(await refused({addGroups: [platform]})).toStrictEqual({code: "DIRECTORY_UNAVAILABLE", status: 503});
    const overMcp = await callToolResult(ada, "artifact_set_grants", {
      addGroups: [{id: platform.id, name: "Platform"}],
      artifactId: draft.id,
    });
    expect(overMcp.isError).toBe(true);
    expect(groupRows(await activity(ada, draft.id))).toHaveLength(rowsBefore);
    const kept = grantListSchema.parse(await (await request(ada, "GET", `${draft.id}/grants`)).json());
    expect(kept.grants.map(({grantee}) => grantee)).toStrictEqual(["erin@example.test", dep.id]);

    // A group that left the directory gives no access and can still be removed.
    directory.setMembers(dep.id, ["oid-ben"]);
    now += groupMembershipCacheMilliseconds;
    expect((await request(ben, "GET", draft.id)).status).toBe(200);
    directory.removeGroup(dep.id);
    now += groupMembershipCacheMilliseconds;
    expect((await request(ben, "GET", draft.id)).status).toBe(missing);
    expect((await change(ada, draft.id, {removeGroups: [dep]})).status).toBe(200);
  });

  test("AUTH-040 foundation: an installation without a directory refuses group grants and reports the capability off", async () => {
    expect.hasAssertions();
    await server.stop();
    server = await startTestServer(installation);
    administrator = await signInAdministrator(server, installation);
    const draft = await publishAs(ada, "Ada's page without a directory", "restricted");
    const response = await change(ada, draft.id, {addGroups: [dep]});
    expect(response.status).toBe(409);
    expect(errorSchema.parse(await response.json()).error.code).toBe("GROUP_SHARING_UNAVAILABLE");
    expect((await searchGroups(ben, "prod")).status).toBe(409);
    expect(await groupSharingCapability()).toBe(false);
    // Person grants behave as before.
    expect((await change(ada, draft.id, {add: ["ben@example.test"]})).status).toBe(200);
    expect((await request(ben, "GET", draft.id)).status).toBe(200);
  });

  test("AUTH-041-B: a member finds groups by a word start and by an exact address, over HTTP and MCP", async () => {
    expect.hasAssertions();
    expect(await groupSharingCapability()).toBe(true);
    const byName = groupSearchSchema.parse(await (await searchGroups(ben, "prod")).json());
    expect(byName.groups).toStrictEqual([{displayName: dep.name, id: dep.id, mail: "dep@example.test"}]);
    const byAddress = groupSearchSchema.parse(await (await searchGroups(ben, " platform@example.test ")).json());
    expect(byAddress.groups.map(({id}) => id)).toStrictEqual([platform.id]);
    const overMcp = groupSearchSchema.parse(await callTool(ben, "artifact_group_search", {query: "arch"}));
    expect(overMcp.groups.map(({displayName}) => displayName)).toStrictEqual([guild.name]);
    for (let index = 0; index < 15; index += 1) {
      directory.addGroup({displayName: `Squad ${index}`, id: `squad-${index}`, mail: null}, []);
    }
    const many = groupSearchSchema.parse(await (await searchGroups(ben, "squad")).json());
    expect(many.groups).toHaveLength(10);
  });

  test("AUTH-041-F: service and anonymous callers are refused, bad queries are refused, and query text stays a literal", async () => {
    expect.hasAssertions();
    expect((await searchGroups(service, "prod")).status).toBe(403);
    const anonymous = await fetch(`${server.baseUrl}/api/v1/directory/groups?query=prod`);
    expect(anonymous.status).toBe(401);
    const overMcp = await callToolResult(service, "artifact_group_search", {query: "prod"});
    expect(overMcp.isError).toBe(true);
    const statuses = await Promise.all(["p", "", "x".repeat(65), "   "].map(async (query) =>
      (await searchGroups(ben, query)).status));
    expect(statuses).toStrictEqual([422, 422, 422, 422]);
    expect(directory.calls.search).toBe(0);
    const hostile = 'x" OR "displayName:a';
    const answer = groupSearchSchema.parse(await (await searchGroups(ben, hostile)).json());
    expect(answer.groups).toStrictEqual([]);
    expect(directory.lastQueries).toStrictEqual([hostile]);
  });

  async function groupSharingCapability(): Promise<boolean> {
    const response = await fetch(`${server.baseUrl}/api/v1/session`, {headers: headersFor(ben)});
    expect(response.status).toBe(200);
    return sessionSchema.parse(await response.json()).capabilities.groupSharing;
  }

  function searchGroups(actor: Actor, query: string): Promise<Response> {
    return fetch(
      `${server.baseUrl}/api/v1/directory/groups?${new URLSearchParams({query}).toString()}`,
      {headers: headersFor(actor)},
    );
  }

  function change(actor: Actor, artifactId: string, body: GrantChange): Promise<Response> {
    return mutate(actor, "PATCH", `${artifactId}/grants`, body);
  }

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

  async function activity(actor: Actor, artifactId: string) {
    const response = await request(actor, "GET", `${artifactId}/actions?limit=100`);
    expect(response.status).toBe(200);
    return activitySchema.parse(await response.json());
  }

  function as(actor: Actor): TestInstallation {
    return {...installation, apiToken: actor.token};
  }

  async function memberWithKey(displayName: string, email: string, subject: string): Promise<Actor> {
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName, email}),
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(admitted.status).toBe(201);
    const memberId = memberSchema.parse(await admitted.json()).member.id;
    const database = openDatabase();
    try {
      database.prepare(
        `INSERT INTO external_identities (provider, subject, member_id, email, bound_at)
         VALUES (?, ?, ?, ?, '2026-11-12T00:00:00.000Z')`,
      ).run(identityProvider, subject, memberId, email);
    } finally {
      database.close();
    }
    return issueKey(memberId, `${displayName}'s key`);
  }

  async function issueKey(memberId: string | undefined, name: string): Promise<Actor> {
    const keyRequest = {capabilities: [...allCapabilities], expiresAt: "2099-01-01T00:00:00.000Z", name};
    const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify(memberId === undefined ? keyRequest : {...keyRequest, memberId}),
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
    accessSetting: "account_required" | "restricted",
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

  async function listedNames(actor: Actor, scope?: "mine" | "shared_with_me"): Promise<string[]> {
    const query = scope === undefined ? "" : `?scope=${scope}`;
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts${query}`, {headers: headersFor(actor)});
    expect(response.status).toBe(200);
    return artifactPageSchema.parse(await response.json()).artifacts.map(({artifact}) => artifact.name);
  }

  function request(actor: Actor, method: string, artifactPath: string): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactPath}`, {headers: headersFor(actor), method});
  }

  function mutate(
    actor: Actor,
    method: string,
    artifactPath: string,
    body: GrantChange | Readonly<Record<string, string | readonly string[]>>,
  ): Promise<Response> {
    const headers = headersFor(actor);
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", crypto.randomUUID());
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactPath}`, {
      body: JSON.stringify(body),
      headers,
      method,
    });
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
          `SELECT COUNT(*) AS total FROM ${table} WHERE artifact_id = ? AND principal_id = ?`,
        ).get(artifactId, principalId)).total,
        0,
      );
    } finally {
      database.close();
    }
  }

  function openDatabase(): DatabaseSync {
    return new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"));
  }
});
