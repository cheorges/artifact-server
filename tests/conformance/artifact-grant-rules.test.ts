import {Effect, Exit} from "effect";
import {describe, expect, test} from "vitest";

import {
  canSeeArtifact,
  needsGrantLookup,
  requireRestrictedManagement,
  restrictedArtifactScope,
  restrictedDispatchScope,
} from "../../src/core/artifact-visibility.js";
import {parseEmailAddress} from "../../src/core/email-address.js";
import {
  membershipRoles,
  principalKinds,
  type MembershipRole,
  type Principal,
} from "../../src/core/identity.js";
import {accessSettings} from "../../src/core/model.js";

function human(id: string, role: MembershipRole): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: id,
    id,
    installationId: "installation",
    kind: principalKinds.human,
    membershipRole: role,
  };
}

const owner = human("member_owner", membershipRoles.member);
const grantee = human("member_grantee", membershipRoles.member);
const administrator = human("member_admin", membershipRoles.administrator);
const service: Principal = {...grantee, id: "service:key", kind: principalKinds.service};
const restricted = {accessSetting: accessSettings.restricted, ownerPrincipalId: owner.id};
const members = {accessSetting: accessSettings.accountRequired, ownerPrincipalId: owner.id};

describe("grant-aware visibility", () => {
  test("AUTH-037 foundation: a matching grant makes a restricted artifact visible, nothing else changes", () => {
    expect(canSeeArtifact(grantee, restricted, true)).toBe(true);
    expect(canSeeArtifact(grantee, restricted, false)).toBe(false);
    expect(canSeeArtifact(service, restricted, true)).toBe(false);
    expect(canSeeArtifact(owner, restricted, false)).toBe(true);
    expect(canSeeArtifact(administrator, restricted, false)).toBe(true);
    expect(canSeeArtifact(grantee, members, false)).toBe(true);
  });

  test("AUTH-037 foundation: only humans who are neither owner nor administrator need a grant lookup", () => {
    expect(needsGrantLookup(grantee, restricted)).toBe(true);
    expect(needsGrantLookup(owner, restricted)).toBe(false);
    expect(needsGrantLookup(administrator, restricted)).toBe(false);
    expect(needsGrantLookup(grantee, members)).toBe(false);
    expect(needsGrantLookup(service, restricted)).toBe(false);
  });

  test("AUTH-037 foundation: management of a restricted artifact stays with owner and administrators", () => {
    expect(Exit.isSuccess(Effect.runSyncExit(requireRestrictedManagement(owner, restricted)))).toBe(true);
    expect(Exit.isSuccess(Effect.runSyncExit(requireRestrictedManagement(administrator, restricted)))).toBe(true);
    expect(Exit.isFailure(Effect.runSyncExit(requireRestrictedManagement(grantee, restricted)))).toBe(true);
    expect(Exit.isSuccess(Effect.runSyncExit(requireRestrictedManagement(grantee, members)))).toBe(true);
  });

  test("AUTH-037 foundation: listing includes grants, dispatch does not", () => {
    expect(restrictedArtifactScope(grantee, [])).toStrictEqual({groupIds: [], kind: "owned_or_granted", principalId: grantee.id});
    expect(restrictedDispatchScope(grantee)).toStrictEqual({kind: "owned", principalId: grantee.id});
    expect(restrictedArtifactScope(administrator, [])).toStrictEqual({kind: "all"});
    expect(restrictedDispatchScope(administrator)).toStrictEqual({kind: "all"});
    expect(restrictedArtifactScope(service, [])).toStrictEqual({kind: "none"});
    expect(restrictedDispatchScope(service)).toStrictEqual({kind: "none"});
  });
});

describe("parseEmailAddress", () => {
  test.each([
    [" Anna.Muster@Company.Example ", "anna.muster@company.example"],
    ["a@b", "a@b"],
  ])("AUTH-038 foundation: parses %j into its stored form", (input, expected) => {
    expect(parseEmailAddress(input)).toBe(expected);
  });

  test.each(["", "ab", "no-at-sign", `${"x".repeat(320)}@y`])("AUTH-038 foundation: refuses %j", (input) => {
    expect(parseEmailAddress(input)).toBeNull();
  });
});
