# 0032: Only the owner and administrators delete an artifact

**Status:** Accepted
**Date:** November 9, 2026

Amends AUTH-008 and the mutation policy in the product specification. Builds
on 0030, which records every artifact's owner.

## Decision

Deleting an artifact needs one of two things: the caller owns it, or the
caller is an installation administrator signed in as themselves. The owner is
the principal that created the artifact: a member through their browser
session, MCP sign-in, or their own API key, or the service key that published
it. An API key also needs the management capability, as for every other
management change. No capability lets anyone else delete,
`artifact:manage:any` included.

| Caller | Delete own artifact | Delete someone else's |
| --- | --- | --- |
| Member (browser session or MCP sign-in) | yes | no |
| Member's own API key | yes, with management capability | no |
| Installation administrator, signed in as themselves | yes | yes |
| Administrator's own API key | yes, with management capability | no |
| Service key | yes, what it published, with management capability | no, whatever its capabilities |

Everything else in AUTH-008 stays as it is. In particular, any member may
still restore an earlier version ("Make current") on a colleague's artifact:
a restore can be undone by restoring again, a delete cannot. The web
interface names the owner before a member makes a version current on
someone else's artifact, and offers Delete only to those allowed to use it.

## Why

A delete tombstones the artifact for everyone and the server has no undelete.
Under AUTH-008-B every member could delete any artifact shared with
everyone, and the web interface offered Delete on a colleague's page without
saying whose it was (UAT, November 5, 2026). Agent hooks that ask before a
delete run only inside Claude Code and do not cover the browser.

## Consequences

- A rotated key keeps its principal, so it keeps deleting what it published.
  A key that is revoked and issued again is a new principal: only
  administrators delete the old key's artifacts.
- On a local installation the CLI publishes with the installation's
  bootstrap key, a service key. Artifacts published in the browser or
  through an MCP sign-in belong to the person, so the CLI cannot delete
  them; the signed-in administrator can delete any artifact.

## Requirements

- **AUTH-036:** only the owner and administrators delete an artifact,
  through HTTP, MCP, and the web interface; everyone else is refused and the
  artifact stays listed.
- **AUTH-008** no longer lists delete among the actions every member may take.

## Rejected alternatives

### An undelete or a retention window

Recovers mistakes, but needs a second lifecycle state, a purge job, and a
retention decision on every backend, while the mistake stays possible.

### Owner-only restore as well

A restore is reversible and members use it to roll back a broken publish of
a shared page. Asking first in the interface is enough.

### Delete only for human owners

Would stop a service key from cleaning up the pages it published, which the
local CLI's own key and release automation rely on.
