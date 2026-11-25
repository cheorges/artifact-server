/** Who a grant names: a person by email address, or a directory group by id. */
export const artifactGranteeKinds = {email: "email", group: "group"} as const;

/** One kind of grantee. */
export type ArtifactGranteeKind = (typeof artifactGranteeKinds)[keyof typeof artifactGranteeKinds];

/** Upper bound of grants on one artifact. */
export const maximumArtifactGrants = 100;

/** One person or directory group an artifact is shared with. */
export interface ArtifactGrant {
  /** The name a group had when it was added; null for a person. */
  readonly displayName: string | null;
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
