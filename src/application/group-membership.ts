import {Effect} from "effect";

import {
  groupLookupBackoffMilliseconds,
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
  /** Tell the operator why a lookup failed; the reason holds no secret. */
  readonly reportFailure: (reason: string) => Effect.Effect<void>;
  /** The directory subject bound to a principal, or null when there is none. */
  readonly subjectOf: (principalId: string) => Promise<string | null>;
}

/** What is known about one principal until `expiresAt`. */
interface RememberedGroups {
  readonly expiresAt: number;
  readonly groupIds: readonly string[];
}

/** One finished lookup: the groups, or why they could not be read. */
type Lookup =
  | {readonly groupIds: readonly string[]; readonly kind: "found"}
  | {readonly kind: "failed"; readonly reason: string};

/**
 * Remember each principal's group ids for five minutes per process, so
 * visibility and listing never ask the directory per artifact. A failed
 * lookup is never remembered as a membership: the principal counts as a
 * member of no group, and the directory is asked again after half a minute.
 * Requests that arrive together share one lookup.
 */
export function createGroupMembership(input: GroupMembershipInput): GroupMembership {
  const {directory} = input;
  if (directory === null) return {groupIdsOf: () => Effect.succeed([])};
  const remembered = new Map<string, RememberedGroups>();
  const running = new Map<string, Promise<Lookup>>();

  const lookUp = async (principalId: string): Promise<Lookup> => {
    try {
      const subject = await input.subjectOf(principalId);
      const groupIds = subject === null ? [] : await directory.groupIdsOfSubject(subject);
      remembered.set(principalId, {
        expiresAt: input.now() + groupMembershipCacheMilliseconds,
        groupIds,
      });
      return {groupIds, kind: "found"};
    } catch (cause) {
      remembered.set(principalId, {
        expiresAt: input.now() + groupLookupBackoffMilliseconds,
        groupIds: [],
      });
      return {
        kind: "failed",
        reason: cause instanceof Error ? cause.message : "The lookup failed.",
      };
    }
  };

  /** The lookup already under way for this principal, or a new one. */
  const shared = (principalId: string): Promise<Lookup> => {
    const current = running.get(principalId);
    if (current !== undefined) return current;
    const started = lookUp(principalId).finally(() => {
      running.delete(principalId);
    });
    running.set(principalId, started);
    return started;
  };

  return {
    groupIdsOf: (principalId) => {
      const known = remembered.get(principalId);
      if (known !== undefined && known.expiresAt > input.now()) {
        return Effect.succeed(known.groupIds);
      }
      const first = !running.has(principalId);
      return Effect.promise(() => shared(principalId)).pipe(
        Effect.flatMap((lookup) => {
          if (lookup.kind === "found") return Effect.succeed(lookup.groupIds);
          // One report per failed lookup, not one per request that shared it.
          const none: readonly string[] = [];
          return first
            ? input.reportFailure(lookup.reason).pipe(Effect.as(none))
            : Effect.succeed(none);
        }),
      );
    },
  };
}
