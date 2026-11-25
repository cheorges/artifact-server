import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {ManagedRuntime, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {GrantLimitReached} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {accessSettings} from "../../src/core/model.js";
import type {ListArtifacts, RestrictedArtifactScope} from "../../src/core/ports.js";
import {SystemClock, SystemIdGenerator} from "../../src/core/system.js";
import {createLocalApplicationLayer} from "../../src/local/create-local-application-layer.js";
import {LocalBlobStore} from "../../src/storage/local-blob-store.js";
import {LocalStagingStore} from "../../src/storage/local-staging-store.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";
import {publishInProcess} from "../support/in-process-publishing.js";

const installationId = "test-installation";
const changedAt = "2026-11-10T09:00:00.000Z";
const anna = "anna.muster@company.example";

const publisher: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [
    principalCapabilities.createArtifact,
    principalCapabilities.manageAnyArtifact,
    principalCapabilities.publishAnyArtifact,
    principalCapabilities.readArtifacts,
  ],
  displayName: "Grant storage fixture",
  id: "grant-storage-service-principal",
  installationId,
  kind: principalKinds.service,
  membershipRole: membershipRoles.member,
};

const holderRowsSchema = z.array(z.object({principalId: z.string()}));
const artifactLocationSchema = z.object({projectId: z.string(), versionId: z.string()});
const schemaVersionSchema = z.object({user_version: z.number()});
const columnRowsSchema = z.array(z.object({name: z.string()}));
const sharingRowsSchema = z.array(z.object({
  action: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  grantee: z.string().nullable(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  versionId: z.string(),
}));

function schemaVersion(database: DatabaseSync): number {
  return schemaVersionSchema.parse(database.prepare("PRAGMA user_version").get()).user_version;
}

interface PublishedFixture {
  readonly artifactId: string;
  readonly projectId: string;
  readonly versionId: string;
}

function insertMember(
  database: DatabaseSync,
  id: string,
  email: string,
  role: "administrator" | "member" = "member",
): void {
  database.prepare(
    `INSERT INTO installation_members
       (id, installation_id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, installationId, email, id, role, changedAt, changedAt);
}

function insertContentAccess(
  database: DatabaseSync,
  token: string,
  principalId: string,
  artifact: PublishedFixture,
): void {
  for (const table of ["content_sessions", "content_bootstraps"] as const) {
    database.prepare(
      `INSERT INTO ${table}
         (token_digest, principal_id, project_id, artifact_id, version_id, content_token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')`,
    ).run(`${table}-${token}`, principalId, artifact.projectId, artifact.artifactId, artifact.versionId, token, changedAt);
  }
}

function contentAccessHolders(database: DatabaseSync, artifactId: string): readonly string[] {
  const rows = database.prepare(
    `SELECT principal_id AS principalId FROM content_sessions WHERE artifact_id = ?
     UNION ALL
     SELECT principal_id AS principalId FROM content_bootstraps WHERE artifact_id = ?
     ORDER BY principalId`,
  ).all(artifactId, artifactId);
  return holderRowsSchema.parse(rows).map(({principalId}) => principalId);
}

function listCommand(
  projectId: string,
  restrictedScope: RestrictedArtifactScope,
  sharedWithPrincipalId: string | null = null,
): ListArtifacts {
  return {
    comments: "all",
    cursor: null,
    limit: 50,
    ownerPrincipalId: null,
    projectId,
    restrictedScope,
    search: null,
    sharedWithGroupIds: [],
      sharedWithPrincipalId,
    sort: "newest",
    tags: [],
  };
}

function benScope(groupIds: readonly string[]): RestrictedArtifactScope {
  return {groupIds, kind: "owned_or_granted", principalId: "member_ben"};
}

describe("SQLite artifact grants", () => {
  let dataDirectory: string;
  let databasePath: string;
  let repository: SqliteArtifactRepository;
  let identityRepository: SqliteIdentityRepository;
  let runtime: ApplicationRuntime;
  let database: DatabaseSync;

  async function publishRestricted(name: string, ownerId: string): Promise<PublishedFixture> {
    const published = await publishInProcess(runtime, {
      idempotencyKey: `grant-storage-${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
      principal: publisher,
    });
    database.prepare("UPDATE artifacts SET owner_principal_id = ?, restricted = 1 WHERE id = ?")
      .run(ownerId, published.artifact.id);
    const location = artifactLocationSchema.parse(
      database.prepare("SELECT project_id AS projectId, current_version_id AS versionId FROM artifacts WHERE id = ?")
        .get(published.artifact.id),
    );
    return {artifactId: published.artifact.id, ...location};
  }

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-grants-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
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
      installationId,
      interactiveIdentityProvider: null,
      localBootstrapCredential: null,
      protectBootstrapAdministrator: false,
      repository,
      staging: new LocalStagingStore(path.join(dataDirectory, "staging")),
    }));
    await runtime.context();
    database = new DatabaseSync(databasePath);
    insertMember(database, "member_owner", "owner@company.example");
    insertMember(database, "member_anna", anna);
    insertMember(database, "member_ben", "ben@company.example");
    insertMember(database, "member_admin", "admin@company.example", "administrator");
  });

  afterEach(async () => {
    database.close();
    await runtime.dispose();
    identityRepository.close();
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("AUTH-038 foundation: the current schema holds a grant table that names people and groups only", () => {
    expect(schemaVersion(database)).toBe(requiredSqliteSchemaVersion);
    const columns = columnRowsSchema.parse(database.prepare("PRAGMA table_info(artifact_grants)").all())
      .map(({name}) => name);
    expect(columns).toStrictEqual([
      "artifact_id", "grantee_kind", "grantee", "granted_by_principal_id", "granted_at", "display_name",
    ]);
    expect(() => database.prepare(
      `INSERT INTO artifact_grants (artifact_id, grantee_kind, grantee, granted_by_principal_id, granted_at)
       VALUES ('a', 'team', 'g', 'p', 't')`,
    ).run()).toThrow(/CHECK/u);
  });

  test("AUTH-038 foundation: an older database gains the grant table on open", async () => {
    database.exec("DROP TABLE artifact_grants;");
    database.exec(`PRAGMA user_version = ${requiredSqliteSchemaVersion - 1};`);
    const reopened = new SqliteArtifactRepository(databasePath);
    try {
      expect(schemaVersion(database)).toBe(requiredSqliteSchemaVersion);
      expect(database.prepare("PRAGMA table_info(artifact_grants)").all()).toHaveLength(6);
    } finally {
      reopened.close();
    }
  });

  test("AUTH-037 foundation: a grant matches an active member by current email only", async () => {
    const artifact = await publishRestricted("Grant target", "member_owner");
    const granted = await repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [anna], artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: artifact.projectId, remove: [],
    });
    expect(granted).toStrictEqual({
      active: true,
      grants: [{displayName: null, grantedAt: changedAt, grantedByPrincipalId: "member_owner", grantee: anna, kind: "email"}],
    });
    expect(await repository.isArtifactGrantee(artifact.projectId, artifact.artifactId, "member_anna", [])).toBe(true);
    expect(await repository.isArtifactGrantee(artifact.projectId, artifact.artifactId, "member_ben", [])).toBe(false);

    database.prepare("UPDATE installation_members SET email = 'anna@elsewhere.example' WHERE id = 'member_anna'").run();
    expect(await repository.isArtifactGrantee(artifact.projectId, artifact.artifactId, "member_anna", [])).toBe(false);
    database.prepare("UPDATE installation_members SET email = ?, status = 'inactive' WHERE id = 'member_anna'").run(anna);
    expect(await repository.isArtifactGrantee(artifact.projectId, artifact.artifactId, "member_anna", [])).toBe(false);
  });

  test("AUTH-038 foundation: adding twice is a no-op and the list reports whether it applies", async () => {
    const artifact = await publishRestricted("Repeated grant", "member_owner");
    const command = {
      add: [anna], addGroups: [], artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: artifact.projectId, remove: [], removeGroups: [],
    };
    await repository.changeArtifactGrants(command);
    const repeated = await repository.changeArtifactGrants({...command, changedAt: "2026-11-11T00:00:00.000Z", principalId: "member_admin"});
    expect(repeated.grants).toStrictEqual([{displayName: null, grantedAt: changedAt, grantedByPrincipalId: "member_owner", grantee: anna, kind: "email"}]);

    database.prepare("UPDATE artifacts SET restricted = 0 WHERE id = ?").run(artifact.artifactId);
    expect(await repository.listArtifactGrants(artifact.projectId, artifact.artifactId)).toStrictEqual({
      active: false,
      grants: repeated.grants,
    });
  });

  test("AUTH-038 foundation: a change above the cap is refused and changes nothing", async () => {
    const artifact = await publishRestricted("Capped grants", "member_owner");
    const hundred = Array.from({length: 100}, (_, index) => `person${index}@company.example`);
    await repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: hundred, artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: artifact.projectId, remove: [],
    });
    await expect(repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [anna], artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: artifact.projectId, remove: [],
    })).rejects.toBeInstanceOf(GrantLimitReached);
    expect((await repository.listArtifactGrants(artifact.projectId, artifact.artifactId)).grants).toHaveLength(100);

    const swapped = await repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [anna], artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: artifact.projectId, remove: ["person0@company.example"],
    });
    expect(swapped.grants).toHaveLength(100);
    expect(swapped.grants.map(({grantee}) => grantee)).toContain(anna);
  });

  test("AUTH-037 foundation: listings include granted artifacts and shared-with-me keeps only them", async () => {
    const granted = await publishRestricted("Shared with Anna", "member_owner");
    await publishRestricted("Anna's own", "member_anna");
    await publishRestricted("Not shared", "member_owner");
    const open = await publishRestricted("Open to members", "member_owner");
    database.prepare("UPDATE artifacts SET restricted = 0 WHERE id = ?").run(open.artifactId);
    await repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [anna], artifactId: granted.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: granted.projectId, remove: [],
    });
    await repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [anna], artifactId: open.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: open.projectId, remove: [],
    });
    const {projectId} = granted;
    const names = async (command: ListArtifacts) =>
      (await repository.listArtifacts(command)).items.map(({name}) => name).toSorted();

    expect(await names(listCommand(projectId, {groupIds: [], kind: "owned_or_granted", principalId: "member_anna"})))
      .toStrictEqual(["Anna's own", "Open to members", "Shared with Anna"]);
    expect(await names(listCommand(projectId, {kind: "owned", principalId: "member_anna"})))
      .toStrictEqual(["Anna's own", "Open to members"]);
    expect(await names(listCommand(projectId, {groupIds: [], kind: "owned_or_granted", principalId: "member_anna"}, "member_anna")))
      .toStrictEqual(["Shared with Anna"]);
    expect(await names(listCommand(projectId, {groupIds: [], kind: "owned_or_granted", principalId: "member_ben"}, "member_ben")))
      .toStrictEqual([]);
  });

  test("AUTH-038 foundation: switching to restricted keeps only the owner's and grantees' content access", async () => {
    const artifact = await publishRestricted("Switch target", "member_owner");
    database.prepare("UPDATE artifacts SET restricted = 0 WHERE id = ?").run(artifact.artifactId);
    await repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [anna], artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: artifact.projectId, remove: [],
    });
    for (const principalId of ["member_owner", "member_anna", "member_ben", "member_admin"]) {
      insertContentAccess(database, `token-${principalId}`, principalId, artifact);
    }
    await repository.changeAccessSetting({
      accessSetting: accessSettings.restricted,
      artifactId: artifact.artifactId,
      authorizedByPrincipalId: null,
      createdAt: changedAt,
      expectedCurrentVersionId: artifact.versionId,
      idempotencyKey: "grant-storage-switch-to-restricted",
      inputDigest: "a".repeat(64),
      principalId: "member_owner",
      projectId: artifact.projectId,
    });
    // An administrator's content may come from a member-bound key, which cannot
    // see a restricted artifact; administrators open it again from the browser.
    expect(contentAccessHolders(database, artifact.artifactId)).toStrictEqual([
      "member_anna", "member_anna", "member_owner", "member_owner",
    ]);
  });

  test("AUTH-038 foundation: removing a grant ends that member's content access to that artifact only", async () => {
    const first = await publishRestricted("First shared", "member_owner");
    const second = await publishRestricted("Second shared", "member_owner");
    await Promise.all([first, second].map((artifact) => repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [anna], artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: artifact.projectId, remove: [],
    })));
    for (const artifact of [first, second]) {
      insertContentAccess(database, `anna-${artifact.artifactId}`, "member_anna", artifact);
      insertContentAccess(database, `owner-${artifact.artifactId}`, "member_owner", artifact);
    }
    await repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [], artifactId: first.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: first.projectId, remove: [anna],
    });
    expect(contentAccessHolders(database, first.artifactId)).toStrictEqual(["member_owner", "member_owner"]);
    expect(contentAccessHolders(database, second.artifactId))
      .toStrictEqual(["member_anna", "member_anna", "member_owner", "member_owner"]);
  });

  test("AUTH-038 foundation: removing the owner's own address keeps the owner's content access", async () => {
    const artifact = await publishRestricted("Owner removes self", "member_owner");
    await repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [anna, "owner@company.example"], artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: artifact.projectId, remove: [],
    });
    insertContentAccess(database, "owner-self", "member_owner", artifact);
    insertContentAccess(database, "anna-self", "member_anna", artifact);
    await repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add: [], artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt, principalId: "member_owner", projectId: artifact.projectId,
      remove: [anna, "owner@company.example"],
    });
    expect(contentAccessHolders(database, artifact.artifactId)).toStrictEqual(["member_owner", "member_owner"]);
  });

  test("AUTH-039 foundation: the actions table has a nullable grantee column and an older database gains it", () => {
    const columns = () => columnRowsSchema.parse(database.prepare("PRAGMA table_info(actions)").all())
      .map(({name}) => name);
    expect(columns()).toContain("grantee");
    database.exec("ALTER TABLE actions DROP COLUMN grantee;");
    database.exec(`PRAGMA user_version = ${requiredSqliteSchemaVersion - 1};`);
    const reopened = new SqliteArtifactRepository(databasePath);
    try {
      expect(schemaVersion(database)).toBe(requiredSqliteSchemaVersion);
      expect(requiredSqliteSchemaVersion).toBe(17);
      expect(columns()).toContain("grantee");
    } finally {
      reopened.close();
    }
  });

  test("AUTH-039 foundation: listing without grant changes skips sharing rows and pages exactly", async () => {
    const artifact = await publishRestricted("Activity paging", "member_owner");
    const insertSharingRow = database.prepare(
      `INSERT INTO actions (
         id, project_id, artifact_id, version_id, action, principal_id,
         authorized_by_principal_id, idempotency_key, created_at, grantee
       ) VALUES (?, ?, ?, ?, 'grant_add', 'member_owner', NULL, ?, ?, ?)`,
    );
    for (const index of [0, 1, 2, 3, 4]) {
      insertSharingRow.run(
        `sharing-row-${index}`,
        artifact.projectId,
        artifact.artifactId,
        artifact.versionId,
        `grant_add:${String(index).padStart(32, "0")}`,
        `2999-01-0${index + 1}T00:00:00.000Z`,
        `person${index}@company.example`,
      );
    }
    const page = (includeGrantChanges: boolean, limit: number) => repository.listArtifactActions({
      artifactId: artifact.artifactId,
      cursor: null,
      includeGrantChanges,
      limit,
      projectId: artifact.projectId,
    });

    const hidden = await page(false, 1);
    expect(hidden.items.map(({action}) => action)).toStrictEqual(["publish"]);
    expect(hidden.nextCursor).toBeNull();

    const shown = await page(true, 2);
    expect(shown.items.map(({action, grantee}) => ({action, grantee}))).toStrictEqual([
      {action: "grant_add", grantee: "person4@company.example"},
      {action: "grant_add", grantee: "person3@company.example"},
    ]);
    expect(shown.nextCursor).not.toBeNull();
    expect((await page(true, 10)).items.at(-1)).toMatchObject({action: "publish", grantee: null});
  });

  test("AUTH-039 foundation: only real grant changes write one sharing row each, in the same transaction", async () => {
    const artifact = await publishRestricted("Sharing rows", "member_owner");
    const sharingRows = (artifactId: string) => sharingRowsSchema.parse(database.prepare(
      `SELECT action, authorized_by_principal_id AS authorizedByPrincipalId, grantee,
              idempotency_key AS idempotencyKey, principal_id AS principalId, version_id AS versionId
       FROM actions WHERE artifact_id = ? AND action IN ('grant_add', 'grant_remove')
       ORDER BY action, grantee`,
    ).all(artifactId));
    const change = (
      target: PublishedFixture,
      add: readonly string[],
      remove: readonly string[],
      authorizedByPrincipalId: string | null = null,
    ) => repository.changeArtifactGrants({
      addGroups: [],
      removeGroups: [],
      add,
      artifactId: target.artifactId,
      authorizedByPrincipalId,
      changedAt,
      principalId: "member_owner",
      projectId: target.projectId,
      remove,
    });
    const row = (action: string, grantee: string, authorizedByPrincipalId: string | null) => ({
      action,
      authorizedByPrincipalId,
      grantee,
      idempotencyKey: expect.stringMatching(new RegExp(`^${action}:[0-9a-f]{32}$`, "u")),
      principalId: "member_owner",
      versionId: artifact.versionId,
    });

    await change(artifact, [anna, "ben@company.example"], [], "member_owner");
    expect(sharingRows(artifact.artifactId)).toStrictEqual([
      row("grant_add", anna, "member_owner"),
      row("grant_add", "ben@company.example", "member_owner"),
    ]);

    // Repeated adds and removals of addresses not granted write nothing.
    await change(artifact, [anna], []);
    await change(artifact, [], ["ben@company.example", "nobody@company.example"]);
    expect(sharingRows(artifact.artifactId)).toStrictEqual([
      row("grant_add", anna, "member_owner"),
      row("grant_add", "ben@company.example", "member_owner"),
      row("grant_remove", "ben@company.example", null),
    ]);

    // A refused change writes nothing either.
    await expect(change(
      artifact,
      Array.from({length: 100}, (_, index) => `person${index}@company.example`),
      [],
    )).rejects.toBeInstanceOf(GrantLimitReached);
    expect(sharingRows(artifact.artifactId)).toHaveLength(3);

    // Changes on an artifact that is not restricted are recorded too.
    const open = await publishRestricted("Open sharing rows", "member_owner");
    database.prepare("UPDATE artifacts SET restricted = 0 WHERE id = ?").run(open.artifactId);
    await change(open, [anna], []);
    expect(sharingRows(open.artifactId).map(({action, grantee}) => ({action, grantee})))
      .toStrictEqual([{action: "grant_add", grantee: anna}]);
  });

  const dep = {displayName: "Developer Productivity", id: "g-dep"};
  const guild = {displayName: "Architecture Guild", id: "g-guild"};
  const changeGroups = (
    target: PublishedFixture,
    addGroups: readonly {displayName: string; id: string}[],
    removeGroups: readonly string[],
    add: readonly string[] = [],
  ) => repository.changeArtifactGrants({
    add,
    addGroups,
    artifactId: target.artifactId,
    authorizedByPrincipalId: null,
    changedAt,
    principalId: "member_owner",
    projectId: target.projectId,
    remove: [],
    removeGroups,
  });
  const groupRows = (artifactId: string) => sharingRowsSchema.parse(database.prepare(
    `SELECT action, authorized_by_principal_id AS authorizedByPrincipalId, grantee,
            idempotency_key AS idempotencyKey, principal_id AS principalId, version_id AS versionId
     FROM actions WHERE artifact_id = ? AND action IN ('grant_group_add', 'grant_group_remove')
     ORDER BY action, grantee`,
  ).all(artifactId)).map(({action, grantee}) => ({action, grantee}));

  test("AUTH-040 foundation: a schema 16 database keeps its grants and accepts groups after the upgrade", async () => {
    const artifact = await publishRestricted("Upgrade target", "member_owner");
    database.exec(`
      DROP TABLE artifact_grants;
      CREATE TABLE artifact_grants (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        grantee_kind TEXT NOT NULL CHECK (grantee_kind IN ('email')),
        grantee TEXT NOT NULL,
        granted_by_principal_id TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (artifact_id, grantee_kind, grantee)
      ) STRICT;
      PRAGMA user_version = 16;
    `);
    database.prepare(
      `INSERT INTO artifact_grants (artifact_id, grantee_kind, grantee, granted_by_principal_id, granted_at)
       VALUES (?, 'email', ?, 'member_owner', ?)`,
    ).run(artifact.artifactId, anna, changedAt);
    const reopened = new SqliteArtifactRepository(databasePath);
    try {
      expect(schemaVersion(database)).toBe(17);
      expect(await reopened.isArtifactGrantee(artifact.projectId, artifact.artifactId, "member_anna", [])).toBe(true);
      const list = await reopened.changeArtifactGrants({
        add: [], addGroups: [dep], artifactId: artifact.artifactId, authorizedByPrincipalId: null, changedAt,
        principalId: "member_owner", projectId: artifact.projectId, remove: [], removeGroups: [],
      });
      expect(list.grants).toStrictEqual([
        {displayName: null, grantedAt: changedAt, grantedByPrincipalId: "member_owner", grantee: anna, kind: "email"},
        {displayName: dep.displayName, grantedAt: changedAt, grantedByPrincipalId: "member_owner", grantee: dep.id, kind: "group"},
      ]);
    } finally {
      reopened.close();
    }
  });

  test("AUTH-040 foundation: a group grant gives its members the artifact and the shared list", async () => {
    const artifact = await publishRestricted("Shared with the team", "member_owner");
    await publishRestricted("Ben's own", "member_ben");
    await changeGroups(artifact, [dep, guild], []);
    const granted = (groupIds: readonly string[]) =>
      repository.isArtifactGrantee(artifact.projectId, artifact.artifactId, "member_ben", groupIds);
    expect(await granted(["g-dep"])).toBe(true);
    expect(await granted(["g-other", "g-guild"])).toBe(true);
    expect(await granted([])).toBe(false);
    expect(await granted(["g-other"])).toBe(false);

    const names = async (command: ListArtifacts) =>
      (await repository.listArtifacts(command)).items.map(({name}) => name).toSorted();
    expect(await names(listCommand(artifact.projectId, benScope(["g-dep"]))))
      .toStrictEqual(["Ben's own", "Shared with the team"]);
    expect(await names(listCommand(artifact.projectId, benScope([])))).toStrictEqual(["Ben's own"]);
    expect(await names({...listCommand(artifact.projectId, benScope(["g-dep"]), "member_ben"), sharedWithGroupIds: ["g-dep"]}))
      .toStrictEqual(["Shared with the team"]);
    expect(await names({...listCommand(artifact.projectId, benScope(["g-dep"]), "member_ben"), sharedWithGroupIds: []}))
      .toStrictEqual([]);
    // The owner's own artifact is never "shared with" the owner, group or not.
    expect(await names({
      ...listCommand(artifact.projectId, {groupIds: ["g-dep"], kind: "owned_or_granted", principalId: "member_owner"}, "member_owner"),
      sharedWithGroupIds: ["g-dep"],
    })).toStrictEqual([]);
  });

  test("AUTH-040 foundation: only real group changes write a row, and only the owner's listing shows them", async () => {
    const artifact = await publishRestricted("Group sharing rows", "member_owner");
    await changeGroups(artifact, [dep], []);
    await changeGroups(artifact, [dep], ["g-absent"]);
    expect(groupRows(artifact.artifactId)).toStrictEqual([{action: "grant_group_add", grantee: dep.displayName}]);
    await changeGroups(artifact, [], ["g-dep"]);
    expect(groupRows(artifact.artifactId)).toStrictEqual([
      {action: "grant_group_add", grantee: dep.displayName},
      {action: "grant_group_remove", grantee: dep.displayName},
    ]);
    const kinds = async (includeGrantChanges: boolean) => (await repository.listArtifactActions({
      artifactId: artifact.artifactId, cursor: null, includeGrantChanges, limit: 50, projectId: artifact.projectId,
    })).items.map(({action}) => action);
    expect(await kinds(true)).toStrictEqual(expect.arrayContaining(["grant_group_add", "grant_group_remove"]));
    expect((await kinds(false)).filter((action) => action.startsWith("grant_"))).toStrictEqual([]);
  });

  test("AUTH-040 foundation: people and groups share the cap, and a refused change writes nothing", async () => {
    const artifact = await publishRestricted("Cap target", "member_owner");
    await changeGroups(artifact, [], [], Array.from({length: 99}, (_, index) => `person${index}@company.example`));
    await expect(changeGroups(artifact, [dep, guild], [])).rejects.toBeInstanceOf(GrantLimitReached);
    expect(groupRows(artifact.artifactId)).toStrictEqual([]);
    expect((await repository.listArtifactGrants(artifact.projectId, artifact.artifactId)).grants).toHaveLength(99);
    await changeGroups(artifact, [dep], []);
    expect((await repository.listArtifactGrants(artifact.projectId, artifact.artifactId)).grants).toHaveLength(100);
  });

  test("AUTH-040 foundation: removing a group ends content access except the owner's and address grantees'", async () => {
    const artifact = await publishRestricted("Group removal", "member_owner");
    await changeGroups(artifact, [dep, guild], [], [anna]);
    for (const principalId of ["member_owner", "member_anna", "member_ben"]) {
      insertContentAccess(database, `token-${principalId}`, principalId, artifact);
    }
    // A change that removes nothing keeps every session.
    await changeGroups(artifact, [], ["g-absent"]);
    expect(contentAccessHolders(database, artifact.artifactId)).toHaveLength(6);
    await changeGroups(artifact, [], ["g-dep"]);
    expect(contentAccessHolders(database, artifact.artifactId)).toStrictEqual([
      "member_anna", "member_anna", "member_owner", "member_owner",
    ]);
  });

  test("AUTH-040 foundation: deleting the artifact removes its group grants", async () => {
    const artifact = await publishRestricted("Deleted with groups", "member_owner");
    await changeGroups(artifact, [dep], []);
    await repository.deleteArtifact({
      artifactId: artifact.artifactId,
      authorizedByPrincipalId: null,
      createdAt: changedAt,
      expectedCurrentVersionId: artifact.versionId,
      idempotencyKey: "grant-storage-delete-with-groups",
      inputDigest: "b".repeat(64),
      principalId: "member_owner",
      projectId: artifact.projectId,
    });
    expect(database.prepare("SELECT count(*) AS count FROM artifact_grants WHERE artifact_id = ?").get(artifact.artifactId))
      .toEqual({count: 0});
  });
});
