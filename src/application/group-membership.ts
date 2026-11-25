import {Effect} from "effect";

import {
  groupMembershipCacheMilliseconds,
  type GroupDirectory,
} from "../core/group-directory.js";

/** The directory groups one principal is a member of, as group grants see them. */
export interface GroupMembership {
  /**
   * Directory group ids of a principal. Never fails: without a directory,
   * without a directory subject bound to the principal, or when the
   * directory cannot be asked, the answer is no group (decision 0034).
   */
  readonly groupIdsOf: (principalId: string) => Effect.Effect<readonly string[]>;
}

/** What {@link createGroupMembership} is built from. */
export interface GroupMembershipInput {
  /** The installation's directory, or null when it has none. */
  readonly directory: GroupDirectory | null;
  /** Milliseconds since the epoch, from the application clock. */
  readonly now: () => number;
  /** The directory subject bound to a principal, or null when there is none. */
  readonly subjectOf: (principalId: string) => Promise<string | null>;
}

interface RememberedGroups {
  readonly expiresAt: number;
  readonly groupIds: readonly string[];
}

/**
 * Remember each principal's group ids for five minutes per process, so
 * visibility and listing never ask the directory per artifact. Only a
 * successful answer is remembered.
 */
export function createGroupMembership(input: GroupMembershipInput): GroupMembership {
  const remembered = new Map<string, RememberedGroups>();
  const {directory} = input;
  if (directory === null) return {groupIdsOf: () => Effect.succeed([])};
  const lookUp = async (principalId: string): Promise<readonly string[]> => {
    const subject = await input.subjectOf(principalId);
    if (subject === null) return [];
    const groupIds = await directory.groupIdsOfSubject(subject);
    remembered.set(principalId, {
      expiresAt: input.now() + groupMembershipCacheMilliseconds,
      groupIds,
    });
    return groupIds;
  };
  return {
    groupIdsOf: (principalId) => {
      const known = remembered.get(principalId);
      if (known !== undefined && known.expiresAt > input.now()) {
        return Effect.succeed(known.groupIds);
      }
      remembered.delete(principalId);
      return Effect.tryPromise(() => lookUp(principalId)).pipe(
        Effect.catch(() =>
          Effect.logWarning("Group membership lookup failed; treating the caller as a member of no group.").pipe(
            Effect.as<readonly string[]>([]),
          )
        ),
      );
    },
  };
}
