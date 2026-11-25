/**
 * Switching the Entra group directory on (decision 0034): off unless asked
 * for, and refused at start unless sign-in is Entra with the object id as
 * the subject, because the directory knows people by nothing else.
 */

import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Redacted} from "effect";
import {describe, expect, test} from "vitest";

import {loadGroupDirectoryConfiguration} from "../../src/cli/group-directory-configuration.js";
import type {OidcConfiguration} from "../../src/cli/oidc-configuration.js";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const entra: OidcConfiguration = {
  applicationOrigin: "https://artifacts.example.test",
  bootstrapAdministratorEmail: "administrator@example.test",
  clientId: "client-id",
  clientSecret: Redacted.make("oidc-client-secret"),
  issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  scopes: "openid email profile",
  subjectClaim: "oid",
};
const on = {ARTIFACT_SERVER_ENTRA_GROUPS: "on"};

describe("group directory configuration", () => {
  test("AUTH-041 foundation: the directory is off unless it is switched on", async () => {
    expect(await loadGroupDirectoryConfiguration({}, entra)).toBeNull();
    expect(await loadGroupDirectoryConfiguration({ARTIFACT_SERVER_ENTRA_GROUPS: "off"}, entra)).toBeNull();
    await expect(loadGroupDirectoryConfiguration({ARTIFACT_SERVER_ENTRA_GROUPS: "yes"}, entra))
      .rejects.toThrow("ARTIFACT_SERVER_ENTRA_GROUPS");
  });

  test("AUTH-041 foundation: switched on, it takes the tenant from the issuer and the sign-in client's secret", async () => {
    const configuration = await loadGroupDirectoryConfiguration(on, entra);
    expect(configuration).toMatchObject({
      clientId: "client-id",
      identityProvider: `oidc:https://login.microsoftonline.com/${tenantId}/v2.0`,
      tenantId,
    });
    expect(Redacted.value(configuration?.clientSecret ?? Redacted.make(""))).toBe("oidc-client-secret");
  });

  test("AUTH-041 foundation: a separate directory secret wins, also from a file", async () => {
    const direct = await loadGroupDirectoryConfiguration(
      {...on, ARTIFACT_SERVER_ENTRA_GROUPS_CLIENT_SECRET: "graph-secret"},
      entra,
    );
    expect(Redacted.value(direct?.clientSecret ?? Redacted.make(""))).toBe("graph-secret");
    const directory = await mkdtemp(path.join(tmpdir(), "group-directory-secret-"));
    try {
      const file = path.join(directory, "secret");
      await writeFile(file, "graph-secret-from-file\n", {mode: 0o600});
      const fromFile = await loadGroupDirectoryConfiguration(
        {...on, ARTIFACT_SERVER_ENTRA_GROUPS_CLIENT_SECRET_FILE: file},
        entra,
      );
      expect(Redacted.value(fromFile?.clientSecret ?? Redacted.make(""))).toBe("graph-secret-from-file");
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  test("AUTH-041 foundation: switched on without Entra sign-in by object id, the server refuses to start", async () => {
    const refusals = await Promise.all([
      null,
      {...entra, issuer: "https://issuer.example.test"},
      {...entra, issuer: "https://login.microsoftonline.com/common/v2.0"},
      {...entra, subjectClaim: "sub"},
      {...entra, clientSecret: null},
    ].map(async (oidc) => {
      try {
        await loadGroupDirectoryConfiguration(on, oidc);
        return "started";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }));
    for (const refusal of refusals) {
      expect(refusal).toContain("ARTIFACT_SERVER_ENTRA_GROUPS");
      expect(refusal).not.toContain("oidc-client-secret");
    }
    // Without the subject claim setting the subject is `sub`, which the directory does not know.
    const {subjectClaim: _unused, ...withoutClaim} = entra;
    await expect(loadGroupDirectoryConfiguration(on, withoutClaim)).rejects.toThrow("ARTIFACT_SERVER_OIDC_SUBJECT_CLAIM");
  });
});
