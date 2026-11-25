import {Cancel01Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {type FormEvent, useEffect, useState} from "react";

import {api, type ArtifactGrantList} from "@/api/client";

interface PeopleWithAccessProps {
  /** Whether the access setting chosen in the dialog lets the grants apply. */
  readonly applies: boolean;
  readonly artifactId: string;
  readonly disabled: boolean;
  readonly projectId: string;
}

function granteesOf(list: ArtifactGrantList): readonly string[] {
  return list.grants.map(({grantee}) => grantee);
}

/**
 * The people a restricted artifact is shared with, for its owner or an
 * administrator: add and remove them by exact email address (AUTH-038). The
 * list never says whether an address belongs to a member yet.
 */
export function PeopleWithAccess({
  applies,
  artifactId,
  disabled,
  projectId,
}: PeopleWithAccessProps) {
  const [grantees, setGrantees] = useState<readonly string[] | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      try {
        const list = await api.artifactGrants(projectId, artifactId);
        // An add or remove that finished first already holds the newer list.
        if (current) setGrantees((known) => known ?? granteesOf(list));
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

  const change = async (add: readonly string[], remove: readonly string[]): Promise<boolean> => {
    setBusy(true);
    setFailure(null);
    try {
      setGrantees(granteesOf(await api.changeArtifactGrants(projectId, artifactId, add, remove)));
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

  return (
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
  );
}
