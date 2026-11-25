import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ManagedRuntime, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {ArtifactManagementService} from "../../src/application/artifact-management.js";
import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import type {PrincipalDisplayName} from "../../src/core/identity-ports.js";
import {SystemClock, SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {publishInProcess} from "../support/in-process-publishing.js";

const principal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [
    principalCapabilities.createArtifact,
    principalCapabilities.manageAnyArtifact,
    principalCapabilities.publishAnyArtifact,
    principalCapabilities.readArtifacts,
  ],
  displayName: "Name lookup fixture",
  id: "name-lookup-service-principal",
  installationId: "test-installation",
  kind: principalKinds.service,
  membershipRole: membershipRoles.member,
};

/** The real SQLite identity store, except that its name lookup fails. */
class UnavailableNamesRepository extends SqliteIdentityRepository {
  override findPrincipalDisplayNames(): Promise<readonly PrincipalDisplayName[]> {
    return Promise.reject(new Error("The identity database is unavailable."));
  }
}

/**
 * Owner and actor names only label artifacts; a failed lookup must not take
 * the list, details, or activity down with it (AUTH-035).
 */
describe("owner and actor names when the lookup fails", () => {
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;
  let identityRepository: UnavailableNamesRepository;
  let runtime: ApplicationRuntime;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-name-lookup-"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
    identityRepository = new UnavailableNamesRepository(databasePath);
    runtime = ManagedRuntime.make(createLocalApplicationLayer({
      apiToken: Redacted.make("test-api-token"),
      blobs: new LocalBlobStore(path.join(dataDirectory, "blobs")),
      bootstrapAdministratorEmail: "admin@example.test",
      clock: new SystemClock(),
      dispatches: repository,
      externalApiBearerVerifier: null,
      externalMcpBearerVerifier: null,
      externalMcpOAuthVerifier: null,
      ids: new SystemIdGenerator(),
      identityRepository,
      installationId: "test-installation",
      interactiveIdentityProvider: null,
      localBootstrapCredential: null,
      protectBootstrapAdministrator: false,
      repository,
      staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
    }));
    await runtime.context();
  });

  afterEach(async () => {
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("AUTH-035 foundation: a failed name lookup answers the list, details, and activity without names", async () => {
    const published = await publishInProcess(runtime, {
      idempotencyKey: "name-lookup-publish-fixture",
      name: "Name lookup fixture",
      principal,
    });
    const artifactId = published.artifact.id;

    const page = await runtime.runPromise(
      ArtifactManagementService.use((management) => management.listArtifactsWithOwnerNames({
        cursor: null,
        limit: 10,
        principal,
        projectId: null,
        search: null,
        tags: [],
      })),
    );
    expect(page.items.map(({id, ownerDisplayName}) => ({id, ownerDisplayName})))
      .toEqual([{id: artifactId, ownerDisplayName: null}]);

    const details = await runtime.runPromise(
      ArtifactManagementService.use((management) => management.getArtifactWithOwnerName({
        artifactId,
        principal,
        projectId: null,
      })),
    );
    expect(details.ownerDisplayName).toBeNull();

    const activity = await runtime.runPromise(
      ArtifactManagementService.use((management) => management.listArtifactActions({
        artifactId,
        cursor: null,
        limit: 10,
        principal,
        projectId: null,
      })),
    );
    expect(activity.items.length).toBeGreaterThan(0);
    expect(activity.items.every(({actorDisplayName}) => actorDisplayName === null)).toBe(true);
  });
});
