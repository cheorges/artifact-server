import {compactId} from "../lib/compact-id.ts";

/** The parts of the signed-in principal that decide ownership in the interface. */
export interface OwnershipViewer {
  readonly authorizedByPrincipalId: string | null;
  readonly id: string;
  readonly kind: "human" | "service";
  readonly membershipRole: "administrator" | "member";
}

/**
 * Whether the viewer owns the artifact or is an administrator signed in as
 * themselves rather than through a key: the ownership half of the server's
 * delete rule (AUTH-036). Offering Delete also needs management rights,
 * which the caller checks.
 */
export function viewerOwnsOrAdministersArtifact(
  viewer: OwnershipViewer,
  ownerPrincipalId: string | null,
): boolean {
  const signedInAdministrator = viewer.kind === "human"
    && viewer.authorizedByPrincipalId === null
    && viewer.membershipRole === "administrator";
  return signedInAdministrator
    || (ownerPrincipalId !== null && ownerPrincipalId === viewer.id);
}

/**
 * The line Make current adds when the viewer is not the artifact's owner,
 * naming the owner, or showing their short id as Details does when the owner
 * has no name.
 */
export function makeCurrentOwnerNotice(
  viewer: OwnershipViewer,
  ownerPrincipalId: string | null,
  ownerDisplayName: string | null,
): string | null {
  if (ownerPrincipalId === null || ownerPrincipalId === viewer.id) return null;
  return `This page belongs to ${ownerDisplayName ?? compactId(ownerPrincipalId)}.`;
}

/**
 * The short access label on an artifact card and in Details. A restricted
 * artifact the viewer neither owns nor administers can only be visible
 * because it was shared with them (AUTH-037).
 */
export function accessPillLabel(
  viewer: OwnershipViewer,
  access: "account_required" | "public_link" | "restricted",
  ownerPrincipalId: string | null,
): string {
  if (access === "public_link") return "public";
  if (access === "account_required") return "members";
  return viewerOwnsOrAdministersArtifact(viewer, ownerPrincipalId) ? "only me" : "shared with you";
}
