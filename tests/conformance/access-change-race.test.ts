import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {ManagedRuntime, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {ArtifactManagementService} from "../../src/application/artifact-management.js";
import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {StagedUploadService} from "../../src/application/staged-upload.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import type {
  ArtifactAccessSettingChange,
  ChangeArtifactAccessSetting,
} from "../../src/core/ports.js";
import {SystemClock, SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";

const principal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [
    principalCapabilities.createArtifact,
    principalCapabilities.manageAnyArtifact,
    principalCapabilities.publishAnyArtifact,
  ],
  displayName: "Access race fixture",
  id: "access-race-service-principal",
  installationId: "test-installation",
  kind: principalKinds.service,
  membershipRole: membershipRoles.member,
};

/**
 * The real SQLite repository; only its next access change first lets a
 * competing change commit, as a second request would between the service's
 * first read and this change's transaction.
 */
class RacingRepository extends SqliteArtifactRepository {
  beforeNextChange: (() => Promise<void>) | null = null;

  override async changeAccessSetting(
    command: ChangeArtifactAccessSetting,
  ): Promise<ArtifactAccessSettingChange> {
    const competing = this.beforeNextChange;
    this.beforeNextChange = null;
    if (competing !== null) await competing();
    return super.changeAccessSetting(command);
  }
}

/**
 * AUTH-034 decides the recall warning from the setting an access change
 * replaced. That setting must come from the change's own transaction: another
 * change can commit between the service's first read and that transaction.
 */
describe("access change racing another access change", () => {
  let dataDirectory: string;
  let repository: RacingRepository;
  let identityRepository: SqliteIdentityRepository;
  let runtime: ApplicationRuntime;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-access-race-"));
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new RacingRepository(databasePath);
    identityRepository = new SqliteIdentityRepository(databasePath);
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

  test("AUTH-034 foundation: a change that ends a public link committed after the service's first read still warns", async () => {
    const published = await publish();
    repository.beforeNextChange = async () => {
      await repository.changeAccessSetting({
        accessSetting: "public_link",
        artifactId: published.artifact.id,
        authorizedByPrincipalId: null,
        createdAt: new Date().toISOString(),
        expectedCurrentVersionId: published.version.id,
        idempotencyKey: "access-race-competing-public-link",
        inputDigest: "access-race-competing-public-link",
        principalId: principal.id,
        projectId: published.artifact.projectId,
      });
    };

    // The service reads account_required, then the competing change makes it
    // a public link, then this change ends that link.
    const change = await runtime.runPromise(
      ArtifactManagementService.use((management) => management.changeAccess({
        accessSetting: "account_required",
        artifactId: published.artifact.id,
        expectedCurrentVersionId: published.version.id,
        idempotencyKey: "access-race-ends-the-link",
        principal,
        projectId: null,
      })),
    );
    expect(change.previousAccessSetting).toBe("public_link");
    expect(change.artifact.accessSetting).toBe("account_required");
    expect(change.mayHaveEndedPublicLink).toBe(true);

    const replay = await runtime.runPromise(
      ArtifactManagementService.use((management) => management.changeAccess({
        accessSetting: "account_required",
        artifactId: published.artifact.id,
        expectedCurrentVersionId: published.version.id,
        idempotencyKey: "access-race-ends-the-link",
        principal,
        projectId: null,
      })),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.previousAccessSetting).toBeNull();
    expect(replay.mayHaveEndedPublicLink).toBe(true);
  });

  async function publish() {
    const bytes = new TextEncoder().encode("<!doctype html><title>Race</title>");
    const upload = await runtime.runPromise(
      StagedUploadService.use((stagedUploads) => stagedUploads.createUpload({
        entryPath: "index.html",
        files: [{
          mediaType: "text/html; charset=utf-8",
          path: "index.html",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        }],
        principal,
        projectId: null,
      })),
    );
    const file = upload.files[0];
    if (file === undefined) throw new Error("The race fixture upload has no file.");
    await runtime.runPromise(
      StagedUploadService.use((stagedUploads) => stagedUploads.uploadFile({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        principal,
        projectId: null,
        storageToken: file.storageToken,
        uploadId: upload.id,
      })),
    );
    return runtime.runPromise(
      StagedUploadService.use((stagedUploads) => stagedUploads.commitUpload({
        idempotencyKey: "access-race-publish-fixture",
        principal,
        projectId: null,
        target: {
          accessSetting: "account_required",
          kind: "new_artifact",
          name: "Access race fixture",
        },
        uploadId: upload.id,
      })),
    );
  }
});
