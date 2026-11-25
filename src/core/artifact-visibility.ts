import {Effect} from "effect";

import {ArtifactNotFound, AuthorizationDenied} from "./errors.js";
import {
  isHumanAdministrator,
  principalKinds,
  type Principal,
} from "./identity.js";
import {accessSettings, type ArtifactRecord} from "./model.js";
import type {RestrictedArtifactScope} from "./ports.js";

/**
 * Report whether one principal may see an artifact at all.
 *
 * Only `restricted` artifacts narrow visibility: their owner, through any of
 * the owner's own channels, installation administrators, and members whose
 * current email matches one of its grants see them. Service principals never
 * do, whatever their capabilities. Every other access setting leaves the
 * decision to the ordinary capability checks.
 */
export function canSeeArtifact(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "accessSetting" | "ownerPrincipalId">,
  grantedToViewer: boolean,
): boolean {
  if (artifact.accessSetting !== accessSettings.restricted) return true;
  return isHumanAdministrator(principal) || ownsArtifact(principal, artifact) ||
    (principal.kind === principalKinds.human && grantedToViewer);
}

/** Report whether visibility depends on a grant lookup for this principal. */
export function needsGrantLookup(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "accessSetting" | "ownerPrincipalId">,
): boolean {
  return artifact.accessSetting === accessSettings.restricted &&
    principal.kind === principalKinds.human &&
    !isHumanAdministrator(principal) &&
    !ownsArtifact(principal, artifact);
}

/**
 * Fail exactly like a missing artifact when the principal may not see it
 * without a grant: the owner and administrators only, for a restricted one.
 */
export function requireArtifactVisible(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "accessSetting" | "ownerPrincipalId">,
): Effect.Effect<void, ArtifactNotFound> {
  return canSeeArtifact(principal, artifact, false)
    ? Effect.void
    : Effect.fail(new ArtifactNotFound({message: "The artifact does not exist."}));
}

/** Refuse management of a restricted artifact to anyone but its owner or an administrator. */
export function requireRestrictedManagement(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "accessSetting" | "ownerPrincipalId">,
): Effect.Effect<void, AuthorizationDenied> {
  return artifact.accessSetting !== accessSettings.restricted || mayChangeRestriction(principal, artifact)
    ? Effect.void
    : Effect.fail(new AuthorizationDenied({
      message: "Only the owner or an administrator can change who sees this artifact.",
    }));
}

/** Report whether a principal may move an artifact to or from `restricted`. */
export function mayChangeRestriction(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "ownerPrincipalId">,
): boolean {
  return isHumanAdministrator(principal) || ownsArtifact(principal, artifact);
}

/**
 * Report whether a principal owns an artifact or is an installation
 * administrator signed in as themselves: the ownership half of AUTH-036.
 *
 * The owner is the principal that created the artifact, so a member counts
 * through any of their own channels and a service key through the artifact
 * it published. An administrator acting through an API key counts only as
 * the owner of what that key's member owns. Deleting also needs
 * `requireArtifactManagement`; no capability stands in for this check,
 * `artifact:manage:any` included.
 */
export function isOwnerOrHumanAdministrator(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "ownerPrincipalId">,
): boolean {
  return isHumanAdministrator(principal) ||
    (artifact.ownerPrincipalId !== null && artifact.ownerPrincipalId === principal.id);
}

/** The restricted artifacts one principal may list: own and granted ones. */
export function restrictedArtifactScope(
  principal: Principal,
): RestrictedArtifactScope {
  if (isHumanAdministrator(principal)) return {kind: "all"};
  if (principal.kind === principalKinds.human) {
    return {kind: "owned_or_granted", principalId: principal.id};
  }
  return {kind: "none"};
}

/** The restricted artifacts whose threads one principal may dispatch: own ones only. */
export function restrictedDispatchScope(
  principal: Principal,
): RestrictedArtifactScope {
  if (isHumanAdministrator(principal)) return {kind: "all"};
  if (principal.kind === principalKinds.human) {
    return {kind: "owned", principalId: principal.id};
  }
  return {kind: "none"};
}

function ownsArtifact(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "ownerPrincipalId">,
): boolean {
  // A member-bound API key carries the member's id, so it counts as the owner.
  return principal.kind === principalKinds.human &&
    artifact.ownerPrincipalId !== null &&
    artifact.ownerPrincipalId === principal.id;
}
