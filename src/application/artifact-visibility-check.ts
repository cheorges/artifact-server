import {Effect} from "effect";

import {canSeeArtifact, needsGrantLookup} from "../core/artifact-visibility.js";
import {ArtifactNotFound, type ArtifactRepositoryFailure} from "../core/errors.js";
import type {Principal} from "../core/identity.js";
import type {ArtifactRecord} from "../core/model.js";

/** Grant lookup a read path needs to decide restricted visibility. */
export interface ArtifactGrantLookup {
  readonly isArtifactGrantee: (
    projectId: string,
    artifactId: string,
    principalId: string,
  ) => Effect.Effect<boolean, ArtifactRepositoryFailure>;
}

/**
 * Fail like a missing artifact unless the principal may see it: the owner,
 * an administrator, or, for a restricted artifact, an active member whose
 * current email matches one of its grants. Only that last case reads grants.
 */
export function requireVisibleWithGrants(
  lookup: ArtifactGrantLookup,
  principal: Principal,
  artifact: ArtifactRecord,
): Effect.Effect<void, ArtifactNotFound | ArtifactRepositoryFailure> {
  const granted = needsGrantLookup(principal, artifact)
    ? lookup.isArtifactGrantee(artifact.projectId, artifact.id, principal.id)
    : Effect.succeed(false);
  return granted.pipe(Effect.flatMap((isGranted) =>
    canSeeArtifact(principal, artifact, isGranted)
      ? Effect.void
      : Effect.fail(new ArtifactNotFound({message: "The artifact does not exist."}))
  ));
}
