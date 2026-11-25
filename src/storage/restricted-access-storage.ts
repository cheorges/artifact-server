import {z} from "zod";

import {artifactGranteeKinds} from "../core/artifact-grants.js";
import {accessSettings, type AccessSetting} from "../core/model.js";
import type {RestrictedArtifactScope} from "../core/ports.js";

/** One stored grant, as every backend selects it. */
export const artifactGrantRowSchema = z.object({
  /** Null for a person, and for backends that do not select the column yet. */
  displayName: z.string().nullable().default(null),
  grantedAt: z.string(),
  grantedByPrincipalId: z.string(),
  grantee: z.string(),
  kind: z.enum([artifactGranteeKinds.email, artifactGranteeKinds.group]),
});

/** The text that tells a member who reached the grant cap. */
export function grantLimitMessage(maximum: number): string {
  return `An artifact can be shared with at most ${maximum} people and groups.`;
}

/** The stored pair behind one API access setting. */
export interface StoredAccessSetting {
  /** The value kept in the `access_setting` column and its CHECK constraint. */
  readonly accessSetting: "account_required" | "public_link";
  /** Whether the artifact is limited to its owner, administrators and grantees. */
  readonly restricted: boolean;
}

/**
 * Split an API access setting into the stored column pair.
 *
 * `restricted` is kept as a flag beside `access_setting` rather than a third
 * CHECK value, so SQLite and D1 need no rebuild of the `artifacts` table.
 */
export function storedAccessSetting(setting: AccessSetting): StoredAccessSetting {
  return setting === accessSettings.restricted
    ? {accessSetting: accessSettings.accountRequired, restricted: true}
    : {accessSetting: setting, restricted: false};
}

/** SQL that reads the stored pair back as one API access setting. */
export function accessSettingSql(
  alias = "",
  dialect: "postgres" | "sqlite" = "sqlite",
): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  // Postgres stores a real boolean; SQLite and D1 store 0 or 1.
  const flag = dialect === "postgres"
    ? `${prefix}restricted`
    : `${prefix}restricted = 1`;
  return `CASE WHEN ${flag} THEN '${accessSettings.restricted}' ELSE ${prefix}access_setting END`;
}

/**
 * SQLite and D1 SQL that keeps restricted artifacts out of a query unless the
 * scope allows them: every one, the owner's, or those granted to an active
 * member whose current email matches. Binds come from
 * {@link restrictedScopeParameters}, in order. Postgres builds its own text
 * with numbered parameters.
 */
export function restrictedScopeSql(artifact: string): string {
  return `(${artifact}.restricted = 0 OR ? = 1 OR ${artifact}.owner_principal_id = ? OR EXISTS (
    SELECT 1 FROM artifact_grants grant_row
    JOIN installation_members grantee_member ON grantee_member.email = grant_row.grantee
    WHERE grant_row.artifact_id = ${artifact}.id
      AND grant_row.grantee_kind = 'email'
      AND grantee_member.status = 'active'
      AND grantee_member.id = ?) OR ${groupGrantedSql(artifact)})`;
}

/**
 * SQLite and D1 SQL that is true when one of the directory groups in the
 * bound JSON array of ids is granted the artifact (decision 0034).
 */
export function groupGrantedSql(artifact: string): string {
  return `EXISTS (
    SELECT 1 FROM artifact_grants group_grant
    WHERE group_grant.artifact_id = ${artifact}.id
      AND group_grant.grantee_kind = 'group'
      AND group_grant.grantee IN (SELECT value FROM json_each(?)))`;
}

/** The activity kinds that name who an artifact is shared with (AUTH-039, AUTH-040). */
export const sharingActionKindsSql =
  "'grant_add', 'grant_remove', 'grant_group_add', 'grant_group_remove'";

/**
 * SQLite and D1 SQL that keeps only restricted artifacts granted to a member
 * who does not own them, by address or through one of the member's directory
 * groups, or every artifact when the bound member is null. Bind the member
 * id three times, then the JSON array of group ids:
 * {@link sharedWithMemberParameters}.
 */
export function sharedWithMemberSql(artifact: string): string {
  return `(? IS NULL OR (${artifact}.restricted = 1 AND ${artifact}.owner_principal_id IS NOT ? AND (EXISTS (
    SELECT 1 FROM artifact_grants shared_grant
    JOIN installation_members shared_member ON shared_member.email = shared_grant.grantee
    WHERE shared_grant.artifact_id = ${artifact}.id
      AND shared_grant.grantee_kind = 'email'
      AND shared_member.status = 'active'
      AND shared_member.id = ?) OR ${groupGrantedSql(artifact)})))`;
}

/** Bind values for {@link sharedWithMemberSql}. */
export function sharedWithMemberParameters(
  memberId: string | null,
  groupIds: readonly string[],
): readonly [string | null, string | null, string | null, string] {
  return [memberId, memberId, memberId, JSON.stringify(memberId === null ? [] : groupIds)];
}

/**
 * Postgres SQL that is true when an active member of the artifact's
 * installation, whose current email matches one of its grants, has the id
 * in the member placeholder, or when one of the directory groups in the
 * JSON array of ids in the group placeholder is granted the artifact.
 */
export function postgresGrantedToMemberSql(
  artifact: string,
  memberPlaceholder: string,
  groupIdsPlaceholder: string,
): string {
  return `(EXISTS (
    SELECT 1 FROM artifact_grants grant_row
    JOIN installation_members grantee_member
      ON grantee_member.installation_id = grant_row.installation_id
      AND grantee_member.email = grant_row.grantee
    WHERE grant_row.installation_id = ${artifact}.installation_id
      AND grant_row.artifact_id = ${artifact}.id
      AND grant_row.grantee_kind = 'email'
      AND grantee_member.status = 'active'
      AND grantee_member.id = ${memberPlaceholder}::text)
    OR EXISTS (
    SELECT 1 FROM artifact_grants group_grant
    WHERE group_grant.installation_id = ${artifact}.installation_id
      AND group_grant.artifact_id = ${artifact}.id
      AND group_grant.grantee_kind = 'group'
      AND group_grant.grantee IN (
        SELECT jsonb_array_elements_text(${groupIdsPlaceholder}::jsonb))))`;
}

/**
 * Bind values for {@link restrictedScopeSql}: all flag, owner id, grantee
 * id, and the JSON array of the reader's directory group ids.
 */
export function restrictedScopeParameters(
  scope: RestrictedArtifactScope,
): readonly [number, string | null, string | null, string] {
  if (scope.kind === "all") return [1, null, null, "[]"];
  if (scope.kind === "owned") return [0, scope.principalId, null, "[]"];
  if (scope.kind === "owned_or_granted") {
    return [0, scope.principalId, scope.principalId, JSON.stringify(scope.groupIds)];
  }
  return [0, null, null, "[]"];
}
