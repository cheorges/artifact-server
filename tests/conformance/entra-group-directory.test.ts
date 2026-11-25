/**
 * The Entra group directory over Microsoft Graph (decision 0034, AUTH-040,
 * AUTH-041), against a loopback stand-in: the exact queries it sends, how it
 * reads their answers, and that every failure is "directory unavailable"
 * without a secret in sight.
 */

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {createEntraGroupDirectory} from "../../src/identity/entra-group-directory.js";
import type {GroupDirectory} from "../../src/core/group-directory.js";
import {startStubGraphServer, type StubGraphServer} from "../support/stub-graph-server.js";

const dep = "11111111-1111-4111-8111-111111111111";
const guild = "22222222-2222-4222-8222-222222222222";
const hidden = "33333333-3333-4333-8333-333333333333";
const ben = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The error a directory call rejects with; a call that succeeds is itself a failure of the test. */
function failureOf(call: Promise<object | null>): Promise<Error> {
  return call.then(
    () => new Error("The directory call did not fail."),
    (error: Error) => error,
  );
}

describe("the Entra group directory", () => {
  let graph: StubGraphServer;
  let directory: GroupDirectory;

  beforeEach(async () => {
    graph = await startStubGraphServer();
    graph.groups.push(
      {displayName: "Developer Productivity", id: dep, mail: "dep@example.test", members: [ben], visibility: null},
      {displayName: "Architecture Guild", id: guild, mail: null, members: [ben], visibility: "Private"},
      {displayName: "Developer Secrets", id: hidden, mail: "it's@example.test", members: [], visibility: "HiddenMembership"},
    );
    directory = createEntraGroupDirectory({
      clientId: "client-id",
      clientSecret: graph.clientSecret,
      graphOrigin: graph.origin,
      loginOrigin: graph.origin,
      tenantId: graph.tenantId,
      timeoutMilliseconds: 300,
    });
  });

  afterEach(async () => {
    await graph.stop();
  });

  const graphRequests = () => graph.requests.filter(({path}) => path.startsWith("/v1.0/"));

  test("AUTH-041 foundation: a name search sends one literal word-start query and drops hidden-membership groups", async () => {
    const found = await directory.searchGroups("devel");
    expect(found).toStrictEqual([{displayName: "Developer Productivity", id: dep, mail: "dep@example.test"}]);
    const [request] = graphRequests();
    expect(request?.path).toBe("/v1.0/groups");
    expect(request?.consistencyLevel).toBe("eventual");
    expect(Object.fromEntries(request?.query ?? [])).toStrictEqual({
      $count: "true",
      $search: '"displayName:devel"',
      $select: "id,displayName,mail,visibility",
      $top: "10",
    });
  });

  test("AUTH-041 foundation: an address search sends an exact filter, and hostile text cannot add a clause", async () => {
    expect((await directory.searchGroups("dep@example.test")).map(({id}) => id)).toStrictEqual([dep]);
    expect(graphRequests().at(-1)?.query.get("$filter")).toBe("mail eq 'dep@example.test'");
    expect(graphRequests().at(-1)?.query.has("$search")).toBe(false);

    await directory.searchGroups("it's@example.test");
    expect(graphRequests().at(-1)?.query.get("$filter")).toBe("mail eq 'it''s@example.test'");

    // Text that is only quotes and backslashes leaves nothing to search for.
    const before = graphRequests().length;
    expect(await directory.searchGroups('""')).toStrictEqual([]);
    expect(await directory.searchGroups('"\\a')).toStrictEqual([]);
    expect(graphRequests()).toHaveLength(before);

    expect(await directory.searchGroups('a"b\\c" OR "displayName:x')).toStrictEqual([]);
    expect(graphRequests().at(-1)?.query.get("$search")).toBe('"displayName:abc OR displayName:x"');
  });

  test("AUTH-040 foundation: a group is read by id, a missing or malformed id is no group", async () => {
    expect(await directory.findGroup(dep)).toStrictEqual({
      displayName: "Developer Productivity", id: dep, mail: "dep@example.test",
    });
    expect(await directory.findGroup("44444444-4444-4444-8444-444444444444")).toBeNull();
    expect(await directory.findGroup(hidden)).toBeNull();
    const before = graphRequests().length;
    expect(await directory.findGroup("../users")).toBeNull();
    expect(await directory.findGroup("")).toBeNull();
    expect(graphRequests()).toHaveLength(before);
  });

  test("AUTH-040 foundation: membership follows every page, stays on the directory's origin, and never asks for a malformed subject", async () => {
    graph.behavior.pageSize = 1;
    expect([...(await directory.groupIdsOfSubject(ben))].toSorted()).toStrictEqual([dep, guild]);
    const membership = graphRequests().filter(({path}) => path.includes("transitiveMemberOf"));
    expect(membership).toHaveLength(2);
    expect(membership[0]?.path).toBe(`/v1.0/users/${ben}/transitiveMemberOf/microsoft.graph.group`);
    expect(membership[0]?.consistencyLevel).toBe("eventual");
    expect(membership[0]?.query.get("$select")).toBe("id");

    graph.behavior.nextLinkOrigin = "http://127.0.0.1:9";
    await expect(directory.groupIdsOfSubject(ben)).rejects.toMatchObject({_tag: "DirectoryUnavailable"});
    const before = graphRequests().length;
    expect(await directory.groupIdsOfSubject("not-an-object-id")).toStrictEqual([]);
    expect(graphRequests()).toHaveLength(before);
  });

  test("AUTH-040 foundation: every refusal, delay, and malformed answer is directory unavailable, with no secret in the error", async () => {
    const failures: Error[] = [];
    for (const status of [403, 429, 500]) {
      graph.behavior.status = status;
      // eslint-disable-next-line no-await-in-loop -- one behavior at a time
      failures.push(await failureOf(directory.groupIdsOfSubject(ben)));
    }
    graph.behavior.status = null;
    graph.behavior.body = '{"value": "x"}';
    failures.push(await failureOf(directory.searchGroups("devel")));
    graph.behavior.body = "not json";
    failures.push(await failureOf(directory.findGroup(dep)));
    graph.behavior.body = null;
    graph.behavior.delayMilliseconds = 600;
    failures.push(await failureOf(directory.searchGroups("devel")));
    graph.behavior.delayMilliseconds = 0;

    expect(failures).toHaveLength(6);
    for (const failure of failures) {
      expect(failure).toMatchObject({_tag: "DirectoryUnavailable"});
      const text = `${String(failure)} ${JSON.stringify(failure)}`;
      expect(text).not.toContain(graph.clientSecret);
      expect(text).not.toContain("stub-graph-token");
    }
    // The directory answers again as soon as Graph does.
    expect((await directory.searchGroups("devel")).map(({id}) => id)).toStrictEqual([dep]);
  });

  test("AUTH-040 foundation: the token is requested once, renewed after a 401, and a wrong secret is directory unavailable", async () => {
    await directory.searchGroups("devel");
    await directory.findGroup(dep);
    expect(graph.tokens).toHaveLength(1);
    const tokenRequest = graph.requests.find(({path}) => path.endsWith("/oauth2/v2.0/token"));
    expect(new URLSearchParams(tokenRequest?.body).get("scope")).toBe("https://graph.microsoft.com/.default");

    graph.behavior.rejectTokenOnce = true;
    expect((await directory.searchGroups("devel")).map(({id}) => id)).toStrictEqual([dep]);
    expect(graph.tokens).toHaveLength(2);

    const wrong = createEntraGroupDirectory({
      clientId: "client-id",
      clientSecret: "wrong-secret",
      graphOrigin: graph.origin,
      loginOrigin: graph.origin,
      tenantId: graph.tenantId,
    });
    await expect(wrong.searchGroups("devel")).rejects.toMatchObject({_tag: "DirectoryUnavailable"});
  });
});
