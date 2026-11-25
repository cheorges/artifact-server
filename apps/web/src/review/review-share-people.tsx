import {Cancel01Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {type FormEvent, useEffect, useState} from "react";

import {api, type ArtifactGrantList, type GroupReference} from "@/api/client";

import {GroupsWithAccess} from "./review-share-groups.tsx";

interface PeopleWithAccessProps {
  /** Whether the access setting chosen in the dialog lets the grants apply. */
  readonly applies: boolean;
  readonly artifactId: string;
  readonly disabled: boolean;
  /** Whether the installation has a directory of groups to share with. */
  readonly groupSharing: boolean;
  readonly projectId: string;
}

type Grants = ArtifactGrantList["grants"];

function addressesOf(grants: Grants): readonly string[] {
  return grants.filter(({kind}) => kind === "email").map(({grantee}) => grantee);
}

function groupsOf(grants: Grants): readonly GroupReference[] {
  return grants
    .filter(({kind}) => kind === "group")
    .map(({displayName, grantee}) => ({id: grantee, name: displayName ?? grantee}));
}

/**
 * The people and directory groups a restricted artifact is shared with, for
 * its owner or an administrator: people are added and removed by exact email
 * address (AUTH-038), groups by search where the installation has a
 * directory (AUTH-040). The list never says whether an address belongs to a
 * member yet.
 */
export function PeopleWithAccess({
  applies,
  artifactId,
  disabled,
  groupSharing,
  projectId,
}: PeopleWithAccessProps) {
  const [grants, setGrants] = useState<Grants | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      try {
        const list = await api.artifactGrants(projectId, artifactId);
        // An add or remove that finished first already holds the newer list.
        if (current) setGrants((known) => known ?? list.grants);
      } catch (caught) {
        if (current) {
          setFailure(
            caught instanceof Error ? caught.message : "The people with access could not be loaded.",
          );
        }
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [artifactId, projectId]);

  const change = async (
    add: readonly string[],
    remove: readonly string[],
    addGroups: readonly GroupReference[] = [],
    removeGroups: readonly GroupReference[] = [],
  ): Promise<boolean> => {
    setBusy(true);
    setFailure(null);
    try {
      const list = await api.changeArtifactGrants(projectId, artifactId, add, remove, addGroups, removeGroups);
      setGrants(list.grants);
      return true;
    } catch (caught) {
      setFailure(
        caught instanceof Error ? caught.message : "The people with access could not be changed.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addPerson = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (await change([address], [])) setAddress("");
  };

  const grantees = grants === null ? null : addressesOf(grants);

  return (
    <>
    <fieldset className="as-share-people" data-applies={applies}>
      <legend>People with access</legend>
      {applies ? null : (
        <p className="as-share-people__inactive">
          Not used while this setting is selected. Kept for when you switch back.
        </p>
      )}
      {/* The server checks addresses, so its message reaches the person. */}
      <form className="as-share-people__add" noValidate onSubmit={(event) => void addPerson(event)}>
        <input
          aria-label="Email address"
          autoComplete="off"
          disabled={disabled || busy}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="name@company.example"
          type="email"
          value={address}
        />
        <button
          className="as-button"
          disabled={disabled || busy || address.trim() === ""}
          type="submit"
        >
          Add
        </button>
      </form>
      {failure === null ? null : (
        <p className="as-share-message" data-tone="error" role="alert">{failure}</p>
      )}
      {grantees === null || grantees.length === 0 ? null : (
        <ul className="as-share-people__list">
          {grantees.map((grantee) => (
            <li key={grantee}>
              <span>{grantee}</span>
              <button
                aria-label={`Remove ${grantee}`}
                className="as-icon-button"
                disabled={disabled || busy}
                onClick={() => void change([], [grantee])}
                type="button"
              >
                <HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="as-share-people__note">
        Admins can always see it. People are matched by email when they sign in.
      </p>
    </fieldset>
    {groupSharing ? (
      <GroupsWithAccess
        applies={applies}
        disabled={disabled || busy}
        groups={grants === null ? [] : groupsOf(grants)}
        onAdd={(group) => change([], [], [group], [])}
        onRemove={(group) => change([], [], [], [group])}
      />
    ) : null}
    </>
  );
}
