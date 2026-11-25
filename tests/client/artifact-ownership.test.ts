/**
 * The web interface mirrors the ownership half of the server's delete rule
 * (AUTH-036) and names the owner before a member makes a version current on
 * someone else's artifact.
 */

import {describe, expect, test} from "vitest";

import {
  makeCurrentOwnerNotice,
  viewerOwnsOrAdministersArtifact,
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
  test("the owner and an administrator signed in as themselves pass the ownership check", () => {
    expect(viewerOwnsOrAdministersArtifact(member, "member_ben")).toBe(true);
    expect(viewerOwnsOrAdministersArtifact(member, "member_ada")).toBe(false);
    expect(viewerOwnsOrAdministersArtifact(member, null)).toBe(false);
    expect(viewerOwnsOrAdministersArtifact(administrator, "member_ada")).toBe(true);
    expect(viewerOwnsOrAdministersArtifact(administratorKey, "member_ada")).toBe(false);
    expect(viewerOwnsOrAdministersArtifact(serviceKey, "service_bot")).toBe(true);
    expect(viewerOwnsOrAdministersArtifact(serviceKey, "member_ada")).toBe(false);
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
