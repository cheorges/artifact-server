import {Effect} from "effect";

import {
  groupLookupBackoffMilliseconds,
  groupLookupDeadlineMilliseconds,
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
  /** How long a request waits for one lookup; tests shorten it. */
  readonly deadlineMilliseconds?: number;
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
 * Requests that arrive together share one lookup, and none waits longer than
 * the deadline: a slower lookup counts as failed, and its answer is still
 * remembered when it arrives.
 */
export function createGroupMembership(input: GroupMembershipInput): GroupMembership {
  const {directory} = input;
  if (directory === null) return {groupIdsOf: () => Effect.succeed([])};
  const remembered = new Map<string, RememberedGroups>();
  const running = new Map<string, Promise<Lookup>>();
  const deadlineMilliseconds = input.deadlineMilliseconds ?? groupLookupDeadlineMilliseconds;

  /** Treat the principal as a member of no group until the back-off ends. */
  const backOff = (principalId: string): void => {
    remembered.set(principalId, {
      expiresAt: input.now() + groupLookupBackoffMilliseconds,
      groupIds: [],
    });
  };

  /** Ask the directory and remember what it says, however long it takes. */
  const ask = async (principalId: string): Promise<Lookup> => {
    try {
      const subject = await input.subjectOf(principalId);
      const groupIds = subject === null ? [] : await directory.groupIdsOfSubject(subject);
      remembered.set(principalId, {
        expiresAt: input.now() + groupMembershipCacheMilliseconds,
        groupIds,
      });
      return {groupIds, kind: "found"};
    } catch (cause) {
      backOff(principalId);
      return {
        kind: "failed",
        reason: cause instanceof Error ? cause.message : "The lookup failed.",
      };
    }
  };

  /** One lookup as the waiting requests see it: the answer, or a failure at the deadline. */
  const lookUp = (principalId: string): Promise<Lookup> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Lookup>((resolve) => {
      timer = setTimeout(() => {
        backOff(principalId);
        resolve({kind: "failed", reason: "The directory did not answer in time."});
      }, deadlineMilliseconds);
    });
    const answered = ask(principalId).finally(() => {
      clearTimeout(timer);
    });
    return Promise.race([answered, late]);
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
