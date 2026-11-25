# 0033: Grants to persons on restricted artifacts

**Status:** Accepted
**Date:** November 10, 2026

Extends 0030. Artifacts that are not `restricted` keep their behavior.

## Decision

The owner of a `restricted` artifact, or an administrator, can grant access
to people by exact email address. An active member whose current email
matches a grant can find the artifact, list it under "Shared with me", open
every version, compare versions, and read and write comments. Only the owner
and administrators publish, restore, change tags, access or grants, delete,
or dispatch it; an API key also needs the management capability to read or
change grants, as for an access change. With no grants, `restricted` behaves
exactly as 0030 describes.

| Request | Result |
| --- | --- |
| Grantee lists, reads, opens content, compares, comments | allowed |
| Grantee publishes, restores, changes tags, access or grants, deletes, dispatches, clears or removes other people's comments | refused |
| Grantee asks for a git-history credential | not available, the same answer as when git history is off |
| Anyone else (member or service principal) | not found, as in 0030 |

## Recorded decisions

### Exact email, no directory

Grants name an email address. Members cannot search other members: member
listing stays administrator-only, so sharing does not turn the installation
into a directory. The grant list answers the addresses the owner typed, only
to the owner and administrators, and never says whether an address belongs
to a member.

### Grants for people who are not members yet

A grant is stored for any well-formed address and matches as soon as an
active member with that email exists, whichever way they were admitted. The
answer is the same for members and non-members, so the share dialog does not
reveal who is a member. Grants match the email recorded when the member was
admitted; Artifact Server does not update it when the issuer's email changes,
so a grant keeps following the recorded address.

### Grants are kept while not restricted

Grants are stored independently of the access setting and only take effect
while the artifact is `restricted`. Switching away and back restores them.

### Revocation at change time

Removing a grant deletes that person's content sessions and bootstraps for
the artifact in the same transaction, unless that person owns it. Deleting an
artifact removes its grants in the same transaction. Switching to
`restricted` keeps the sessions of the owner and current grantees and ends
everyone else's, administrators' included: a content session does not record
whether a member-bound key opened it, and such a key cannot see a restricted
artifact, so administrators open it again from the browser.

### Sharing changes are recorded

Every grant addition and removal writes one activity row per person, naming the address, who made the change and when, and
for an API key, whose key it was. Only real changes are recorded: a repeated add or the removal of an address that is not
granted writes nothing, and a refused change writes nothing. Only the owner and administrators see these rows, also after
the artifact is deleted; for everyone else they are left out of the activity. Deleting an artifact records the deletion only.

### Bounded

At most 100 grants per artifact.

## Requirements

- **AUTH-037:** grantees of a restricted artifact can find, read, open,
  compare and comment on it and list it under "Shared with me"; nobody else
  can.
- **AUTH-038:** only the owner or an administrator reads or changes grants;
  changes are atomic and bounded, and removing access takes effect at once.
- **AUTH-039:** every grant addition and removal is recorded in the
  artifact's activity, one row per person, for the owner and administrators only.

## Rejected alternatives

### Member search for every member

Convenient, but every member could then look up every other member's name
and email.

### Grants by member id with a pending-email table

Survives email changes, but every admission path would have to convert
pending grants, including paths added by other features.

### Viewer and editor roles

A second role in the model, interface and tests; publishing stays with the
owner.
