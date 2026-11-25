/**
 * The web interface offers Delete only where the server allows it (AUTH-036)
 * and names the owner before a member makes a version current on someone
 * else's artifact.
 */

import {describe, expect, test} from "vitest";

import {
  makeCurrentOwnerNotice,
  viewerMayDeleteArtifact,
} from "../../apps/web/src/review/artifact-ownership.js";

const member = {
  authorizedByPrincipalId: null,
  id: "member_ben",
  kind: "human",
  membershipRole: "member",
} as const;
const administrator = {...member, id: "member_admin", membershipRole: "administrator"} as const;
const administratorKey = {...administrator, authorizedByPrincipalId: "member_admin"} as const;
const serviceKey = {
  authorizedByPrincipalId: "member_admin",
  id: "service_bot",
  kind: "service",
  membershipRole: "member",
} as const;

describe("artifact ownership in the web interface", () => {
  test("only the owner and a signed-in administrator are offered Delete", () => {
    expect(viewerMayDeleteArtifact(member, "member_ben")).toBe(true);
    expect(viewerMayDeleteArtifact(member, "member_ada")).toBe(false);
    expect(viewerMayDeleteArtifact(member, null)).toBe(false);
    expect(viewerMayDeleteArtifact(administrator, "member_ada")).toBe(true);
    expect(viewerMayDeleteArtifact(administratorKey, "member_ada")).toBe(false);
    expect(viewerMayDeleteArtifact(serviceKey, "service_bot")).toBe(true);
    expect(viewerMayDeleteArtifact(serviceKey, "member_ada")).toBe(false);
  });

  test("Make current names the owner only on someone else's artifact", () => {
    expect(makeCurrentOwnerNotice(member, "member_ada", "Ada Lovelace"))
      .toBe("This page belongs to Ada Lovelace.");
    expect(makeCurrentOwnerNotice(member, "member_ada", null))
      .toBe("This page belongs to another member.");
    expect(makeCurrentOwnerNotice(member, "member_ben", "Ben Beispiel")).toBeNull();
    expect(makeCurrentOwnerNotice(member, null, null)).toBeNull();
  });
});
