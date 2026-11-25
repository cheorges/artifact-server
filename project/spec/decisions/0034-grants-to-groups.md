# 0034: Grants to directory groups on restricted artifacts

**Status:** Accepted
**Date:** November 12, 2026

Extends 0033. Person grants and artifacts that are not `restricted` keep
their behavior. An installation without a directory keeps the behavior of
0033 and refuses new group grants.

## Decision

The owner of a `restricted` artifact, or an administrator, can also share it
with groups of the installation's directory. An active member whom the
directory reports as a member of such a group, directly or through a nested
group, gets exactly what a person grant gives in 0033: finding the artifact,
"Shared with me", every version, comparing, and comments. Managing stays with
the owner and administrators.

A group grant stores the group's directory id and the display name the group
had when it was added. The id decides access; the name is what people read.

| Request | Result |
| --- | --- |
| Member of a granted group lists, reads, opens content, compares, comments | allowed |
| Member of a granted group manages the artifact in any way | refused, as for a grantee in 0033 |
| Directory cannot be asked, or answers anything unexpected | no access through groups; person grants, ownership and administration are unaffected |
| Adding a group on an installation without a directory | refused |
| Removing a stored group on an installation without a directory | allowed |

## Recorded decisions

### The server reads the directory

The server asks Microsoft Graph with two application permissions, using
client credentials of the sign-in application: `GroupMember.Read.All` to find
groups, and `User.Read.All` to read which groups a signed-in person is in.
The second was not planned. Graph refuses the per-member call without it (see
"The per-member call needs a user permission" below).
A groups claim in the token was rejected: it needs the directory team to
assign every shareable group to the application, and while assignment is
required for sign-in an assigned group's members could also sign in.
`Group.Read.All` was rejected because it also reads group content.

### Ids decide, names label

A change names a group by its `id` and its exact `displayName`, the fields
the group search answers. The server reads the group from the directory and
refuses a name that differs, so the name a person confirmed is the group that
gets access. A group renamed later keeps giving access by id and keeps its
stored name; a group deleted from the directory gives nobody access and can
still be removed from the artifact.

Removing a group needs no directory. When group sharing is switched off,
stored group grants give nobody access, still count toward the cap, stay
visible to the owner and administrators, and can be removed; they apply
again when the directory returns.

### Membership is remembered for five minutes

A caller's group ids are read once and remembered for five minutes per
server process, then passed into the visibility and listing queries, so no
request asks the directory per artifact. Only a successful answer is
remembered. Content sessions keep their 15-minute lifetime, so a person who
left a group in the directory loses access after at most 20 minutes.
Removing a group grant ends the artifact's content sessions at once for
everyone but its owner and the people granted by address.

### Fail closed

Any directory error, timeout, or unexpected answer counts as "member of no
group" for a read and refuses an addition. It is never remembered as a
membership. A caller whose lookup failed is treated as a member of no group
for 30 seconds before the directory is asked again, and requests that arrive
together share one lookup, so a slow or refusing directory is not asked on
every request and does not slow everyone down. No request waits longer than
10 seconds for a lookup: a slower one counts as failed, and its answer is
still remembered when it arrives. The reason of every failure, an HTTP status
at most, goes to the application log.

The directory is asked only when the answer can matter. A grant by address
is checked first and without the directory, so a person granted by address
never waits on it. Listing one's own artifacts, and an administrator's
listings other than "Shared with me", never ask the directory.

### The directory is left alone after it fails

The directory throttles the application as a whole, not one person. After
status 429, a server error, a refused sign-in, or no answer, the adapter
sends nothing for anyone until a pause ends: the time the directory names in
`Retry-After`, five minutes at most, or 30 seconds. Group access stays closed
during the pause. A refusal that concerns one request, such as 403 or 404,
pauses nothing. Requests that need a new token at the same time share one
sign-in.

### Groups share the cap

People and groups together are bounded by the 100 grants of 0033.

### Sharing changes are recorded

Adding or removing a group writes one activity row per group
(`grant_group_add`, `grant_group_remove`), under the rules of 0033's "Sharing
changes are recorded": only real changes, in the same transaction, visible to
the owner and administrators only. The row carries the group's directory id
as `grantee` and the name the group is shared under as `granteeName`.
Directory names are neither unique nor fixed, so the id is what ties a row
to the group that got access.

### Group search

A signed-in member can search groups by the start of a word of the name, or
by an exact mail address, and receives at most 10 groups with `id`,
`displayName`, and mail address. Members are never searched and member lists are never
returned (0033). Service principals cannot search. Groups whose membership
the directory hides are not offered. Group names are visible to every member
through this search; that was accepted for this installation.

### No rate limit on the search

The search needs a signed-in member and at least two characters, and the
browser asks only after typing pauses. There is no limit per person beyond
that. A member or an agent with a member's key who sends very many searches
can make the directory throttle the application; group access then stays
closed for everyone until the pause after the throttling ends. That
was accepted for an installation of signed-in colleagues; a per-person limit
is the answer if it happens.

### Node runtime only

The directory is wired into the Node runtime. The Cloudflare worker binds
people by the issuer's `sub`, which the directory does not know, so it
carries the schema and the shared queries but no directory and refuses group
grants.

### The per-member call needs a user permission

Membership is read with the per-member call
(`/users/{id}/transitiveMemberOf`). Microsoft's permission table lists
`GroupMember.Read.All` among the permissions for it, and this decision first
took that as sufficient. It is not: on a real Entra tenant (2026-11-16) Graph
answered the call with 403 while group search worked with the same token, and
accepted it once the application also had `User.Read.All`, the table's least
privileged application permission for that call. `User.ReadBasic.All` was not
tried.

`User.Read.All` allows more than the server uses: it could read every
person's profile. The server makes one call per signed-in person, for that
person's own object id, and asks for group ids only. An installation that
must not hold a user permission needs the adapter to read membership with the
group-side call (`/groups/{id}/transitiveMembers`), which
`GroupMember.Read.All` covers by the same table and which is unproven. That
call answers "who is in this group", not "which groups is this person in", so
it also changes the port's membership method and its caller; it is a code
change, not a setting.

The server keeps its Graph token until shortly before it expires, an hour as
a rule. A permission granted or removed in the directory therefore takes
effect when the token is renewed or the server restarts.

## Conformance

- AUTH-040: sharing with groups, who gets what, and failure behavior.
- AUTH-041: group search and the optional directory.
