import {Cancel01Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {useEffect, useState} from "react";

import {api, type DirectoryGroup, type GroupReference} from "@/api/client";

interface GroupsWithAccessProps {
  /** Whether the access setting chosen in the dialog lets the grants apply. */
  readonly applies: boolean;
  readonly disabled: boolean;
  /** The groups the artifact is shared with, by id and the name they are shared under. */
  readonly groups: readonly GroupReference[];
  /** Share with one group; resolves to whether it worked. */
  readonly onAdd: (group: GroupReference) => Promise<boolean>;
  readonly onRemove: (group: GroupReference) => Promise<boolean>;
  /** Whether the installation has a directory to search; without one, groups can only be removed. */
  readonly searchable: boolean;
}

/** Shortest text the directory is asked about. */
const minimumSearchCharacters = 2;
/** How long typing must pause before the directory is asked. */
const searchDelayMilliseconds = 300;

type SearchState =
  | {readonly kind: "idle"}
  | {readonly kind: "failed"; readonly message: string}
  | {readonly kind: "found"; readonly groups: readonly DirectoryGroup[]};

const idle: SearchState = {kind: "idle"};

/**
 * The directory groups a restricted artifact is shared with (AUTH-040): find
 * a group by the start of a word of its name or by its mail address, pick
 * it, and remove it again. Only groups are searched, never people.
 */
export function GroupsWithAccess({applies, disabled, groups, onAdd, onRemove, searchable}: GroupsWithAccessProps) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>(idle);
  const wanted = query.trim();

  useEffect(() => {
    if (!searchable || wanted.length < minimumSearchCharacters) {
      setSearch(idle);
      return undefined;
    }
    let current = true;
    const ask = async (): Promise<void> => {
      try {
        const found = await api.searchDirectoryGroups(wanted);
        if (current) setSearch({groups: found, kind: "found"});
      } catch (caught) {
        if (current) {
          setSearch({
            kind: "failed",
            message: caught instanceof Error ? caught.message : "The groups could not be searched.",
          });
        }
      }
    };
    const timer = setTimeout(() => void ask(), searchDelayMilliseconds);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [searchable, wanted]);

  const pick = async (group: DirectoryGroup): Promise<void> => {
    if (await onAdd({displayName: group.displayName, id: group.id})) setQuery("");
  };
  const shared = new Set(groups.map(({id}) => id));
  const options = search.kind === "found" ? search.groups.filter(({id}) => !shared.has(id)) : [];

  return (
    <fieldset className="as-share-people" data-applies={applies}>
      <legend>Groups with access</legend>
      {searchable ? (
        <input
          aria-label="Group name or address"
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search groups by name or address"
          type="text"
          value={query}
        />
      ) : (
        <p className="as-share-people__inactive">
          Group sharing is switched off. These groups give no access now and can only be removed.
        </p>
      )}
      {search.kind === "failed" ? (
        <p className="as-share-message" data-tone="error" role="alert">{search.message}</p>
      ) : null}
      {search.kind === "found" && options.length === 0 ? (
        <p className="as-share-people__note">
          {search.groups.length === 0
            ? "No group found. The search matches the start of a word."
            : "Already shared with every group found."}
        </p>
      ) : null}
      {options.length === 0 ? null : (
        <ul aria-label="Matching groups" className="as-share-groups__options" role="listbox">
          {options.map((group) => (
            <li aria-selected="false" key={group.id} role="option">
              <button disabled={disabled} onClick={() => void pick(group)} type="button">
                <span>{group.displayName}</span>
                {group.mail === null ? null : <span className="as-share-groups__mail">{group.mail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {groups.length === 0 ? null : (
        <ul className="as-share-people__list">
          {groups.map((group) => (
            <li key={group.id}>
              <span>{group.displayName}</span>
              <button
                aria-label={`Remove ${group.displayName}`}
                className="as-icon-button"
                disabled={disabled}
                onClick={() => void onRemove(group)}
                type="button"
              >
                <HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {searchable ? (
        <p className="as-share-people__note">
          Everyone in a group can open and comment. Membership follows the directory within minutes.
        </p>
      ) : null}
    </fieldset>
  );
}
