/** The parts of the signed-in principal that decide ownership in the interface. */
export interface OwnershipViewer {
  readonly authorizedByPrincipalId: string | null;
  readonly id: string;
  readonly kind: "human" | "service";
  readonly membershipRole: "administrator" | "member";
}

/**
 * Whether the interface offers Delete. It mirrors the server rule (AUTH-036):
 * the owner, or an administrator signed in themselves rather than through a key.
 */
export function viewerMayDeleteArtifact(
  viewer: OwnershipViewer,
  ownerPrincipalId: string | null,
): boolean {
  const signedInAdministrator = viewer.kind === "human"
    && viewer.authorizedByPrincipalId === null
    && viewer.membershipRole === "administrator";
  return signedInAdministrator
    || (ownerPrincipalId !== null && ownerPrincipalId === viewer.id);
}

/** The line Make current adds when the viewer is not the artifact's owner. */
export function makeCurrentOwnerNotice(
  viewer: OwnershipViewer,
  ownerPrincipalId: string | null,
  ownerDisplayName: string | null,
): string | null {
  if (ownerPrincipalId === null || ownerPrincipalId === viewer.id) return null;
  return `This page belongs to ${ownerDisplayName ?? "another member"}.`;
}
