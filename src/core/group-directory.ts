/** One group of the installation's directory, as people read it. */
export interface DirectoryGroup {
  readonly displayName: string;
  readonly id: string;
  readonly mail: string | null;
}

/**
 * Read-only view of the installation's directory (decision 0034). Every
 * method rejects with `DirectoryUnavailable` when the directory cannot be
 * asked or answers something unexpected; callers treat that as "no group".
 */
export interface GroupDirectory {
  /** The group with this directory id, or null when there is none. */
  findGroup(groupId: string): Promise<DirectoryGroup | null>;
  /**
   * Ids of every group the person with this directory subject is a member
   * of, directly or through nested groups.
   */
  groupIdsOfSubject(subject: string): Promise<readonly string[]>;
  /**
   * Groups whose name has a word starting with the query, or whose mail
   * address equals it when the query holds an `@`; at most
   * {@link maximumGroupSearchResults}.
   */
  searchGroups(query: string): Promise<readonly DirectoryGroup[]>;
}

/** A directory wired into an installation, and whose subjects it knows. */
export interface GroupSharingConfiguration {
  readonly directory: GroupDirectory;
  /**
   * The identity provider (as external identities are bound, for example
   * `oidc:<issuer>`) whose subject is the person's id in this directory.
   */
  readonly identityProvider: string;
}

/** Upper bound of groups one search answers. */
export const maximumGroupSearchResults = 10;

/** Shortest group search text, after trimming. */
export const minimumGroupSearchCharacters = 2;

/** Longest group search text, after trimming. */
export const maximumGroupSearchCharacters = 64;

/** How long one caller's group ids are remembered per process. */
export const groupMembershipCacheMilliseconds = 5 * 60 * 1_000;

/**
 * How long a caller whose lookup failed is treated as a member of no group
 * before the directory is asked again, so a failing directory is not asked
 * on every request.
 */
export const groupLookupBackoffMilliseconds = 30 * 1_000;

/**
 * How long one request waits for a caller's group ids. A lookup that takes
 * longer counts as failed for the requests waiting on it; its answer is
 * still remembered when it arrives.
 */
export const groupLookupDeadlineMilliseconds = 10 * 1_000;
