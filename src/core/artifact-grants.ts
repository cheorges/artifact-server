/** Who a grant names. Groups follow later as a second kind. */
export const artifactGranteeKinds = {email: "email"} as const;

/** One kind of grantee. */
export type ArtifactGranteeKind = (typeof artifactGranteeKinds)[keyof typeof artifactGranteeKinds];

/** Upper bound of grants on one artifact. */
export const maximumArtifactGrants = 100;

/** One person an artifact is shared with. */
export interface ArtifactGrant {
  readonly grantedAt: string;
  readonly grantedByPrincipalId: string;
  readonly grantee: string;
  readonly kind: ArtifactGranteeKind;
}

/** The grants of one artifact and whether they currently apply. */
export interface ArtifactGrantList {
  readonly active: boolean;
  readonly grants: readonly ArtifactGrant[];
}
