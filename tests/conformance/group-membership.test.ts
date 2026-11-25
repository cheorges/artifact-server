/**
 * The remembered directory membership behind group grants (AUTH-040): asked
 * once per lifetime, never remembered on failure, and empty whenever there
 * is nothing to ask.
 */

import {Effect} from "effect";
import {describe, expect, test} from "vitest";

import {createGroupMembership} from "../../src/application/group-membership.js";
import {
  groupLookupBackoffMilliseconds,
  groupMembershipCacheMilliseconds,
} from "../../src/core/group-directory.js";
import {createFakeGroupDirectory} from "../support/fake-group-directory.js";

function fixture() {
  const directory = createFakeGroupDirectory();
  directory.addGroup({displayName: "Developer Productivity", id: "g-dep", mail: null}, ["oid-ben"]);
  let now = 1_000_000;
  const subjects = new Map([["member_ben", "oid-ben"]]);
  const reasons: string[] = [];
  const membership = createGroupMembership({
    directory,
    now: () => now,
    reportFailure: (reason) => Effect.sync(() => {
      reasons.push(reason);
    }),
    subjectOf: (principalId) => Promise.resolve(subjects.get(principalId) ?? null),
  });
  return {
    reasons,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    directory,
    groupIdsOf: (principalId: string) => Effect.runPromise(membership.groupIdsOf(principalId)),
  };
}

describe("group membership (AUTH-040)", () => {
  test("AUTH-040 foundation: a member's groups are asked once per five minutes", async () => {
    const {advance, directory, groupIdsOf} = fixture();
    expect(await groupIdsOf("member_ben")).toStrictEqual(["g-dep"]);
    directory.setMembers("g-dep", []);
    advance(groupMembershipCacheMilliseconds - 1);
    expect(await groupIdsOf("member_ben")).toStrictEqual(["g-dep"]);
    expect(directory.calls.membership).toBe(1);
    advance(1);
    expect(await groupIdsOf("member_ben")).toStrictEqual([]);
    expect(directory.calls.membership).toBe(2);
  });

  test("AUTH-040 foundation: a failed lookup gives no group, names its reason, and is not asked again for half a minute", async () => {
    const {advance, directory, groupIdsOf, reasons} = fixture();
    directory.failNext(1);
    expect(await groupIdsOf("member_ben")).toStrictEqual([]);
    expect(reasons).toStrictEqual(["The directory cannot be reached."]);
    // The directory answers again, but a failing directory is not asked on every request.
    advance(groupLookupBackoffMilliseconds - 1);
    expect(await groupIdsOf("member_ben")).toStrictEqual([]);
    expect(directory.calls.membership).toBe(1);
    advance(1);
    expect(await groupIdsOf("member_ben")).toStrictEqual(["g-dep"]);
    expect(directory.calls.membership).toBe(2);
    expect(reasons).toHaveLength(1);
  });

  test("AUTH-040 foundation: requests that arrive together share one lookup", async () => {
    const {directory, groupIdsOf} = fixture();
    const answers = await Promise.all([groupIdsOf("member_ben"), groupIdsOf("member_ben"), groupIdsOf("member_ben")]);
    expect(answers).toStrictEqual([["g-dep"], ["g-dep"], ["g-dep"]]);
    expect(directory.calls.membership).toBe(1);
  });

  test("AUTH-040 foundation: a directory that does not answer in time counts as failed, and its late answer is still remembered", async () => {
    const answers: ((groupIds: readonly string[]) => void)[] = [];
    const reasons: string[] = [];
    const membership = createGroupMembership({
      deadlineMilliseconds: 20,
      directory: {
        findGroup: () => Promise.resolve(null),
        groupIdsOfSubject: () => new Promise((resolve) => {
          answers.push(resolve);
        }),
        searchGroups: () => Promise.resolve([]),
      },
      now: () => 1_000_000,
      reportFailure: (reason) => Effect.sync(() => {
        reasons.push(reason);
      }),
      subjectOf: () => Promise.resolve("oid-ben"),
    });
    expect(await Effect.runPromise(membership.groupIdsOf("member_ben"))).toStrictEqual([]);
    expect(reasons).toStrictEqual(["The directory did not answer in time."]);
    // Inside the pause nobody waits again.
    expect(await Effect.runPromise(membership.groupIdsOf("member_ben"))).toStrictEqual([]);
    expect(answers).toHaveLength(1);
    answers[0]?.(["g-dep"]);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(await Effect.runPromise(membership.groupIdsOf("member_ben"))).toStrictEqual(["g-dep"]);
    expect(reasons).toHaveLength(1);
  });

  test("AUTH-040 foundation: nobody without a directory subject is asked about", async () => {
    const {directory, groupIdsOf} = fixture();
    expect(await groupIdsOf("member_without_subject")).toStrictEqual([]);
    expect(await groupIdsOf("service:release-bot")).toStrictEqual([]);
    expect(directory.calls.membership).toBe(0);
    const off = createGroupMembership({
      directory: null,
      now: () => 0,
      reportFailure: () => Effect.void,
      subjectOf: () => Promise.resolve("oid-ben"),
    });
    expect(await Effect.runPromise(off.groupIdsOf("member_ben"))).toStrictEqual([]);
  });
});
