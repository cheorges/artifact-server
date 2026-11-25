import {Redacted, Schema} from "effect";

import type {GroupSharingConfiguration} from "../core/group-directory.js";
import {createEntraGroupDirectory} from "../identity/entra-group-directory.js";
import {loadOptionalCredential} from "../lifecycle/runtime-configuration.js";
import type {OidcConfiguration} from "./oidc-configuration.js";
import {runCliEffect} from "./run-cli-effect.js";

/** Settings of the Entra group directory, read from the environment. */
export interface GroupDirectoryConfiguration {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  /** The provider name sign-in binds people under, whose subject is their directory id. */
  readonly identityProvider: string;
  readonly tenantId: string;
}

const switchName = "ARTIFACT_SERVER_ENTRA_GROUPS";
const secretName = "ARTIFACT_SERVER_ENTRA_GROUPS_CLIENT_SECRET";
const entraIssuerPattern =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/v2\.0$/iu;

/**
 * Read whether artifacts can be shared with Microsoft Entra groups (decision
 * 0034). Off unless `ARTIFACT_SERVER_ENTRA_GROUPS=on`. Switched on, the
 * server must sign people in through one Entra tenant and bind them by
 * object id (`ARTIFACT_SERVER_OIDC_SUBJECT_CLAIM=oid`): the directory knows
 * people by nothing else, so anything else fails here, at start. The
 * directory uses the sign-in client's secret unless
 * `ARTIFACT_SERVER_ENTRA_GROUPS_CLIENT_SECRET` (or its `_FILE`) names another.
 */
export async function loadGroupDirectoryConfiguration(
  environment: NodeJS.ProcessEnv,
  oidc: OidcConfiguration | null,
): Promise<GroupDirectoryConfiguration | null> {
  const value = environment[switchName];
  if (value === undefined || value === "off") return null;
  if (value !== "on") throw new Error(`${switchName} must be "on" or "off".`);
  if (oidc === null) {
    throw new Error(`${switchName}=on needs OIDC sign-in through Microsoft Entra (ARTIFACT_SERVER_OIDC_ISSUER).`);
  }
  const tenantId = entraIssuerPattern.exec(oidc.issuer)?.[1];
  if (tenantId === undefined) {
    throw new Error(
      `${switchName}=on needs ARTIFACT_SERVER_OIDC_ISSUER to be one Entra tenant: https://login.microsoftonline.com/<tenant id>/v2.0.`,
    );
  }
  if (oidc.subjectClaim !== "oid") {
    throw new Error(
      `${switchName}=on needs ARTIFACT_SERVER_OIDC_SUBJECT_CLAIM=oid: the directory knows people by their object id.`,
    );
  }
  const separate = await runCliEffect(loadOptionalCredential(environment, secretName, Schema.NonEmptyString));
  const clientSecret = separate === null ? oidc.clientSecret : separate.value;
  if (clientSecret === null) {
    throw new Error(
      `${switchName}=on needs a client secret: ARTIFACT_SERVER_OIDC_CLIENT_SECRET or ${secretName}.`,
    );
  }
  return {
    clientId: oidc.clientId,
    clientSecret,
    identityProvider: `oidc:${oidc.issuer}`,
    tenantId: tenantId.toLowerCase(),
  };
}

/** The directory an installation shares with, or null when group sharing is off. */
export async function loadGroupSharing(
  environment: NodeJS.ProcessEnv,
  oidc: OidcConfiguration | null,
): Promise<GroupSharingConfiguration | null> {
  const configuration = await loadGroupDirectoryConfiguration(environment, oidc);
  if (configuration === null) return null;
  return {
    directory: createEntraGroupDirectory({
      clientId: configuration.clientId,
      clientSecret: Redacted.value(configuration.clientSecret),
      tenantId: configuration.tenantId,
    }),
    identityProvider: configuration.identityProvider,
  };
}
