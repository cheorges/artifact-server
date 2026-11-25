/**
 * The remembered directory membership behind group grants (AUTH-040): asked
 * once per lifetime, never remembered on failure, and empty whenever there
 * is nothing to ask.
 */

import {Effect} from "effect";
import {describe, expect, test} from "vitest";

import {createGroupMembership} from "../../src/application/group-membership.js";
import {groupMembershipCacheMilliseconds} from "../../src/core/group-directory.js";
import {createFakeGroupDirectory} from "../support/fake-group-directory.js";

function fixture() {
  const directory = createFakeGroupDirectory();
  directory.addGroup({displayName: "Developer Productivity", id: "g-dep", mail: null}, ["oid-ben"]);
  let now = 1_000_000;
  const subjects = new Map([["member_ben", "oid-ben"]]);
  const membership = createGroupMembership({
    directory,
    now: () => now,
    subjectOf: (principalId) => Promise.resolve(subjects.get(principalId) ?? null),
  });
  return {
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

  test("AUTH-040 foundation: a failed lookup gives no group and is asked again", async () => {
    const {directory, groupIdsOf} = fixture();
    directory.failNext(1);
    expect(await groupIdsOf("member_ben")).toStrictEqual([]);
    expect(await groupIdsOf("member_ben")).toStrictEqual(["g-dep"]);
    expect(directory.calls.membership).toBe(2);
  });

  test("AUTH-040 foundation: nobody without a directory subject is asked about", async () => {
    const {directory, groupIdsOf} = fixture();
    expect(await groupIdsOf("member_without_subject")).toStrictEqual([]);
    expect(await groupIdsOf("service:release-bot")).toStrictEqual([]);
    expect(directory.calls.membership).toBe(0);
    const off = createGroupMembership({directory: null, now: () => 0, subjectOf: () => Promise.resolve("oid-ben")});
    expect(await Effect.runPromise(off.groupIdsOf("member_ben"))).toStrictEqual([]);
  });
});
