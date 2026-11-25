import {DirectoryUnavailable} from "../../src/core/errors.js";
import {
  maximumGroupSearchResults,
  type DirectoryGroup,
  type GroupDirectory,
} from "../../src/core/group-directory.js";

/** How often each directory method was asked. */
export interface FakeGroupDirectoryCalls {
  find: number;
  membership: number;
  search: number;
}

/** In-memory directory for tests, with switches a real one does not have. */
export interface FakeGroupDirectory extends GroupDirectory {
  /** Add or replace a group and the subjects that are its members. */
  addGroup(group: DirectoryGroup, memberSubjects: readonly string[]): void;
  readonly calls: FakeGroupDirectoryCalls;
  /** Make the next `count` calls reject with `DirectoryUnavailable`. */
  failNext(count: number): void;
  /** The last text each search received, for injection tests. */
  readonly lastQueries: string[];
  removeGroup(groupId: string): void;
  setMembers(groupId: string, memberSubjects: readonly string[]): void;
}

interface StoredGroup {
  readonly group: DirectoryGroup;
  members: ReadonlySet<string>;
}

/** Create an empty in-memory directory. */
export function createFakeGroupDirectory(): FakeGroupDirectory {
  const groups = new Map<string, StoredGroup>();
  const calls: FakeGroupDirectoryCalls = {find: 0, membership: 0, search: 0};
  const lastQueries: string[] = [];
  let failures = 0;
  const answer = <Value>(value: Value): Promise<Value> => {
    if (failures > 0) {
      failures -= 1;
      return Promise.reject(new DirectoryUnavailable({message: "The directory cannot be reached."}));
    }
    return Promise.resolve(value);
  };
  return {
    addGroup: (group, memberSubjects) => {
      groups.set(group.id, {group, members: new Set(memberSubjects)});
    },
    calls,
    failNext: (count) => {
      failures = count;
    },
    findGroup: (groupId) => {
      calls.find += 1;
      return answer(groups.get(groupId)?.group ?? null);
    },
    groupIdsOfSubject: (subject) => {
      calls.membership += 1;
      return answer([...groups.values()]
        .filter((stored) => stored.members.has(subject))
        .map((stored) => stored.group.id));
    },
    lastQueries,
    removeGroup: (groupId) => {
      groups.delete(groupId);
    },
    searchGroups: (query) => {
      calls.search += 1;
      lastQueries.push(query);
      return answer([...groups.values()]
        .map((stored) => stored.group)
        .filter((group) => matches(group, query))
        .slice(0, maximumGroupSearchResults));
    },
    setMembers: (groupId, memberSubjects) => {
      const stored = groups.get(groupId);
      if (stored !== undefined) stored.members = new Set(memberSubjects);
    },
  };
}

function matches(group: DirectoryGroup, query: string): boolean {
  const wanted = query.toLowerCase();
  if (wanted.includes("@")) return group.mail?.toLowerCase() === wanted;
  return group.displayName.toLowerCase().split(/\s+/u).some((word) => word.startsWith(wanted));
}
