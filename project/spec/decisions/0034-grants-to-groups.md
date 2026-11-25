# 0034: Grants to directory groups on restricted artifacts

**Status:** Accepted
**Date:** November 12, 2026

Extends 0033. Person grants and artifacts that are not `restricted` keep
their behavior. An installation without a directory keeps the behavior of
0033 and refuses group grants.

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
| Group grant on an installation without a directory | refused |

## Recorded decisions

### The server reads the directory

The server asks Microsoft Graph with one application permission,
`GroupMember.Read.All`, using client credentials of the sign-in application.
A groups claim in the token was rejected: it needs the directory team to
assign every shareable group to the application, and while assignment is
required for sign-in an assigned group's members could also sign in.
`Group.Read.All` was rejected because it also reads group content.

### Ids decide, names label

A change names a group by its id and its exact name. The server reads the
group from the directory and refuses a name that differs, so the name a
person confirmed is the group that gets access. A group renamed later keeps
giving access by id and keeps its stored name; a group deleted from the
directory gives nobody access and can still be removed from the artifact.

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
group" for a read and refuses a change. It is never remembered as a
membership. A caller whose lookup failed is treated as a member of no group
for 30 seconds before the directory is asked again, and requests that arrive
together share one lookup, so a slow or refusing directory is not asked on
every request and does not slow everyone down. The reason of every failure,
an HTTP status at most, goes to the application log. Listing one's own
artifacts, and an administrator's listings other than "Shared with me", never
ask the directory.

### Groups share the cap

People and groups together are bounded by the 100 grants of 0033.

### Sharing changes are recorded

Adding or removing a group writes one activity row per group
(`grant_group_add`, `grant_group_remove`) naming the group, under the rules
of 0033's "Sharing changes are recorded": only real changes, in the same
transaction, visible to the owner and administrators only.

### Group search

A signed-in member can search groups by the start of a word of the name, or
by an exact mail address, and receives at most 10 groups with id, name, and
mail address. Members are never searched and member lists are never
returned (0033). Service principals cannot search. Groups whose membership
the directory hides are not offered. Group names are visible to every member
through this search; that was accepted for this installation.

### No rate limit on the search

The search needs a signed-in member and at least two characters, and the
browser asks only after typing pauses. There is no limit per person beyond
that. A member or an agent with a member's key who sends very many searches
can make the directory throttle the application; group access then stays
closed, as for any directory failure, until the directory answers again. That
was accepted for an installation of signed-in colleagues; a per-person limit
is the answer if it happens.

### Node runtime only

The directory is wired into the Node runtime. The Cloudflare worker binds
people by the issuer's `sub`, which the directory does not know, so it
carries the schema and the shared queries but no directory and refuses group
grants.

### If the per-member call is refused

Membership is read with the per-member call
(`/users/{id}/transitiveMemberOf`), which the permission table lists as
allowed for `GroupMember.Read.All`. It cannot be tried before the consent is
granted. If the directory refuses it, group access stays closed, and the
adapter switches to the group-side call (`/groups/{id}/transitiveMembers`
for the granted groups) behind the same port.

## Conformance

- AUTH-040: sharing with groups, who gets what, and failure behavior.
- AUTH-041: group search and the optional directory.
