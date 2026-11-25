import { createHash } from "node:crypto";

import { Context, DateTime, Effect, Layer } from "effect";

import type { ApplicationClock } from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import { parseIdempotencyKey } from "./idempotency-key.js";
import {
  type ArtifactGrantLookup,
  requireVisibleWithGrants,
} from "./artifact-visibility-check.js";
import {
  normalizeArtifactTag,
  parseArtifactTags,
} from "./artifact-tags.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import {
  ArtifactNotFound,
  type ArtifactMutationConflict,
  type ArtifactRepositoryFailure,
  AuthorizationDenied,
  type GrantLimitReached,
  type IdempotencyConflict,
  type IdentityRepositoryFailure,
  InvalidArtifactGrant,
  type InvalidArtifactTags,
  type InvalidIdempotencyKey,
  InvalidPagination,
  VersionNotFound,
} from "../core/errors.js";
import type { ArtifactGrantList } from "../core/artifact-grants.js";
import {
  mayChangeRestriction,
  isOwnerOrHumanAdministrator,
  requireRestrictedManagement,
  restrictedArtifactScope,
} from "../core/artifact-visibility.js";
import { parseEmailAddress } from "../core/email-address.js";
import { type Principal, principalKinds } from "../core/identity.js";
import {
  isPubliclyReadable,
  type PublicLinkPolicy,
  requireAccessSettingAllowed,
} from "../core/public-link-policy.js";
import {
  accessSettings,
  type AccessSetting,
  type ArtifactActionPage,
  type ArtifactActionRecord,
  type ArtifactDeletion,
  type ArtifactListItem,
  type ArtifactPage,
  type ArtifactRecord,
  type ArtifactState,
  type ArtifactVersion,
  type PageCursor,
  type VersionRecord,
} from "../core/model.js";
import type {
  ArtifactAccessSettingChange,
  ChangeArtifactAccessSetting,
  ChangeArtifactGrants,
  ChangeArtifactTags,
  DeleteArtifact,
  ListArtifactActions,
  ListArtifacts,
  RestoreArtifactVersion,
} from "../core/ports.js";

const maximumPageSize = 100;

/** One artifact and the complete record for its current saved version. */
export interface ArtifactDetails {
  readonly artifact: ArtifactRecord;
  readonly current: ArtifactVersion;
}

/** Artifact details with the owner's shown name, for the surfaces that show it. */
export interface ArtifactDetailsWithOwnerName extends ArtifactDetails {
  /** The owner's shown name, or null when the owner is unknown. */
  readonly ownerDisplayName: string | null;
}

/** One listed artifact with its owner's shown name. */
export interface ArtifactListItemWithOwnerName extends ArtifactListItem {
  /** The owner's shown name, or null when the owner is unknown. */
  readonly ownerDisplayName: string | null;
}

/** One bounded page of listed artifacts with their owners' shown names. */
export interface ArtifactPageWithOwnerNames {
  readonly items: readonly ArtifactListItemWithOwnerName[];
  readonly nextCursor: PageCursor | null;
}

/** One recorded action with the shown name of the principal that took it. */
export interface ArtifactActionWithActorName extends ArtifactActionRecord {
  /** The actor's shown name, or null when the actor is unknown. */
  readonly actorDisplayName: string | null;
}

/** One bounded page of recorded actions with their actors' shown names. */
export interface ArtifactActionPageWithActorNames {
  readonly items: readonly ArtifactActionWithActorName[];
  readonly nextCursor: PageCursor | null;
}

/**
 * Which artifacts a list covers: every visible one, only the caller's own, or
 * only restricted ones of others that are granted to the caller.
 */
export type ArtifactListScope = "all" | "mine" | "shared_with_me";

/** One artifact and one exact saved version selected for a version-level action. */
export interface ArtifactVersionDetails {
  readonly artifact: ArtifactRecord;
  readonly saved: ArtifactVersion;
}

/** Input for reading one artifact through authenticated application policy. */
export interface ReadArtifactCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** Input for reading one exact saved version. */
export interface ReadArtifactVersionCommand extends ReadArtifactCommand {
  readonly versionId: string;
}

/** Input for restoring one existing saved version as the current version. */
export interface RestoreArtifactVersionCommand extends ReadArtifactVersionCommand {
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
}

/** Input for changing one artifact's read setting. */
export interface ChangeArtifactAccessCommand extends ReadArtifactCommand {
  readonly accessSetting: AccessSetting;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
}

/** The artifact after an access change, and whether it may have ended a served public link. */
export interface ArtifactAccessChange extends ArtifactAccessSettingChange {
  /**
   * True when the replaced setting was publicly readable and the new one is
   * not, so copies fetched while it was public may still exist elsewhere. A
   * replay replaced nothing and cannot tell what the original change replaced,
   * so it counts the earlier setting as a public link: it answers true
   * whenever public links are on and the new setting is not publicly readable,
   * even if no link ended.
   */
  readonly mayHaveEndedPublicLink: boolean;
}

/** Input for replacing one artifact's complete tag set. */
export interface ChangeArtifactTagsCommand extends ReadArtifactCommand {
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly tags: readonly string[];
}

/** Input for listing active artifacts visible to one principal. */
export interface ListArtifactsCommand {
  readonly comments?: "all" | "with" | "without";
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly principal: Principal;
  readonly projectId: string | null;
  /**
   * `mine` keeps only artifacts the caller owns, `shared_with_me` only
   * restricted artifacts of others granted to the caller; the default is `all`.
   */
  readonly scope?: ArtifactListScope;
  readonly search: string | null;
  readonly sort?: "comments" | "newest";
  readonly tags: readonly string[];
}

/** Input for adding and removing people an artifact is shared with. */
export interface ChangeArtifactGrantsCommand extends ReadArtifactCommand {
  /** Email addresses to add, as typed; normalized before they are stored. */
  readonly add: readonly string[];
  /** Email addresses to remove, as typed; normalized before matching. */
  readonly remove: readonly string[];
}

/** Input for listing one artifact's attributed mutation history. */
export interface ListArtifactActionsCommand extends ReadArtifactCommand {
  readonly cursor: PageCursor | null;
  readonly limit: number;
}

/** Input for atomically tombstoning one artifact. */
export interface DeleteArtifactCommand extends ReadArtifactCommand {
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
}

/** Repository capabilities required by artifact management. */
export interface ArtifactManagementRepository {
  readonly changeAccessSetting: (
    command: ChangeArtifactAccessSetting,
  ) => Effect.Effect<
    ArtifactAccessSettingChange,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | ArtifactRepositoryFailure
  >;
  readonly changeArtifactGrants: (
    command: ChangeArtifactGrants,
  ) => Effect.Effect<
    ArtifactGrantList,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | GrantLimitReached
    | ArtifactRepositoryFailure
  >;
  readonly changeTags: (
    command: ChangeArtifactTags,
  ) => Effect.Effect<
    ArtifactState,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | ArtifactRepositoryFailure
  >;
  readonly deleteArtifact: (
    command: DeleteArtifact,
  ) => Effect.Effect<
    ArtifactDeletion,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | ArtifactRepositoryFailure
  >;
  readonly findArtifact: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | null, ArtifactRepositoryFailure>;
  readonly findArtifactForAdministration: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | null, ArtifactRepositoryFailure>;
  readonly findVersionRecord: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => Effect.Effect<ArtifactVersion | null, ArtifactRepositoryFailure>;
  readonly listArtifactVersions: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<readonly VersionRecord[], ArtifactRepositoryFailure>;
  readonly listArtifactActions: (
    command: ListArtifactActions,
  ) => Effect.Effect<ArtifactActionPage, ArtifactRepositoryFailure>;
  readonly listArtifactGrants: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactGrantList, ArtifactNotFound | ArtifactRepositoryFailure>;
  readonly listArtifacts: (
    command: ListArtifacts,
  ) => Effect.Effect<ArtifactPage, ArtifactRepositoryFailure>;
  readonly restoreVersion: (
    command: RestoreArtifactVersion,
  ) => Effect.Effect<
    ArtifactState,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | VersionNotFound
    | ArtifactRepositoryFailure
  >;
}

/** Looks up the names shown for artifact owners and actors. */
export interface PrincipalNameDirectory {
  /** Map each known principal id to its shown name; unknown ids are absent. */
  readonly findDisplayNames: (
    installationId: string,
    principalIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, string>, IdentityRepositoryFailure>;
}

/** Dependencies used to construct artifact management operations. */
export interface ArtifactManagementDependencies {
  readonly clock: ApplicationClock;
  /** Decides whether a member sees a restricted artifact through a grant. */
  readonly grants: ArtifactGrantLookup;
  readonly principalNames: PrincipalNameDirectory;
  /** Installation switch that refuses new public links when off. */
  readonly publicLinks: PublicLinkPolicy;
  readonly repository: ArtifactManagementRepository;
}

/** Expected failures produced by artifact management. */
export type ArtifactManagementFailure =
  | ArtifactNotFound
  | VersionNotFound
  | ArtifactMutationConflict
  | IdempotencyConflict
  | InvalidIdempotencyKey
  | InvalidArtifactTags
  | InvalidArtifactGrant
  | InvalidPagination
  | AuthorizationDenied
  | GrantLimitReached
  | ArtifactRepositoryFailure
  | ProjectManagementFailure;

interface ArtifactManagementOperations {
  readonly changeAccess: (
    command: ChangeArtifactAccessCommand,
  ) => Effect.Effect<ArtifactAccessChange, ArtifactManagementFailure>;
  /**
   * Add and remove people an artifact is shared with, for its owner or an
   * administrator, and answer the resulting list.
   */
  readonly changeGrants: (
    command: ChangeArtifactGrantsCommand,
  ) => Effect.Effect<ArtifactGrantList, ArtifactManagementFailure>;
  readonly changeTags: (
    command: ChangeArtifactTagsCommand,
  ) => Effect.Effect<ArtifactState, ArtifactManagementFailure>;
  readonly deleteArtifact: (
    command: DeleteArtifactCommand,
  ) => Effect.Effect<ArtifactDeletion, ArtifactManagementFailure>;
  readonly getArtifact: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<ArtifactDetails, ArtifactManagementFailure>;
  /** `getArtifact` plus the owner's shown name, one more lookup. */
  readonly getArtifactWithOwnerName: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<ArtifactDetailsWithOwnerName, ArtifactManagementFailure>;
  /** The people an artifact is shared with, for its owner or an administrator. */
  readonly getGrants: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<ArtifactGrantList, ArtifactManagementFailure>;
  /** `getGrants`, or null for a caller who may not see the list. */
  readonly getGrantsForViewer: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<ArtifactGrantList | null, ArtifactManagementFailure>;
  readonly getVersion: (
    command: ReadArtifactVersionCommand,
  ) => Effect.Effect<ArtifactVersion, ArtifactManagementFailure>;
  readonly getVersionDetails: (
    command: ReadArtifactVersionCommand,
  ) => Effect.Effect<ArtifactVersionDetails, ArtifactManagementFailure>;
  readonly listVersions: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<readonly VersionRecord[], ArtifactManagementFailure>;
  readonly listArtifactActions: (
    command: ListArtifactActionsCommand,
  ) => Effect.Effect<ArtifactActionPageWithActorNames, ArtifactManagementFailure>;
  readonly listArtifacts: (
    command: ListArtifactsCommand,
  ) => Effect.Effect<ArtifactPage, ArtifactManagementFailure>;
  /** `listArtifacts` plus each owner's shown name, one more lookup per page. */
  readonly listArtifactsWithOwnerNames: (
    command: ListArtifactsCommand,
  ) => Effect.Effect<ArtifactPageWithOwnerNames, ArtifactManagementFailure>;
  readonly restoreVersion: (
    command: RestoreArtifactVersionCommand,
  ) => Effect.Effect<ArtifactState, ArtifactManagementFailure>;
}

/** Reads and mutates artifact metadata without changing committed versions. */
export class ArtifactManagementService extends Context.Service<
  ArtifactManagementService,
  ArtifactManagementOperations
>()("artifact-server/application/ArtifactManagementService") {
  /** Construct artifact management from deployment-neutral persistence. */
  static readonly layer = (
    dependencies: ArtifactManagementDependencies,
  ): Layer.Layer<
    ArtifactManagementService,
    never,
    AuthorizationService | ProjectManagementService
  > =>
    Layer.effect(
      ArtifactManagementService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const projects = yield* ProjectManagementService;
        return makeArtifactManagementService(
          dependencies,
          authorization,
          projects,
        );
      }),
    );
}

function normalizeArtifactSearch(candidate: string | null): string | null {
  if (candidate === null) return null;
  const normalized = normalizeArtifactTag(candidate);
  return normalized === "" ? null : normalized;
}

function makeArtifactManagementService(
  dependencies: ArtifactManagementDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
): ArtifactManagementOperations {
  const resolveProjectForRead = Effect.fn(
    "ArtifactManagementService.resolveProjectForRead",
  )(function*(principal: Principal, projectId: string | null) {
    return projectId === null
      ? yield* projects.resolveActiveProject({principal, projectId})
      : yield* projects.getProject({principal, projectId});
  });

  const requireArtifact = Effect.fn("ArtifactManagementService.requireArtifact")(
    function*(projectId: string, artifactId: string): Effect.fn.Return<
      ArtifactRecord,
      ArtifactNotFound | ArtifactRepositoryFailure
    > {
      const artifact = yield* dependencies.repository.findArtifact(
        projectId,
        artifactId,
      );
      if (artifact !== null) return artifact;
      return yield* new ArtifactNotFound({message: "The artifact does not exist."});
    },
  );

  const requireArtifactForAdministration = Effect.fn(
    "ArtifactManagementService.requireArtifactForAdministration",
  )(function*(projectId: string, artifactId: string): Effect.fn.Return<
    ArtifactRecord,
    ArtifactNotFound | ArtifactRepositoryFailure
  > {
    const artifact = yield* dependencies.repository
      .findArtifactForAdministration(projectId, artifactId);
    if (artifact !== null) return artifact;
    return yield* new ArtifactNotFound({message: "The artifact does not exist."});
  });

  // Names only label artifacts, so a failed lookup answers without them (the
  // interface then shows short ids) instead of failing the whole request.
  const displayNames = Effect.fn("ArtifactManagementService.displayNames")(
    function*(principal: Principal, principalIds: readonly (string | null)[]) {
      const ids = [...new Set(principalIds.filter((id) => id !== null))];
      if (ids.length === 0) return new Map<string, string>();
      return yield* dependencies.principalNames.findDisplayNames(
        principal.installationId,
        ids,
      ).pipe(
        Effect.catchTag("IdentityRepositoryFailure", (failure) =>
          Effect.logWarning(
            "Owner and actor names could not be read; answering without them.",
            failure.cause,
          ).pipe(Effect.as(new Map<string, string>()))),
      );
    },
  );

  const requirePageSize = Effect.fn("ArtifactManagementService.requirePageSize")(
    function*(limit: number) {
      if (Number.isInteger(limit) && limit >= 1 && limit <= maximumPageSize) {
        return limit;
      }
      return yield* new InvalidPagination({
        message: `A page must contain between 1 and ${maximumPageSize} records.`,
      });
    },
  );

  const requireVersion = Effect.fn("ArtifactManagementService.requireVersion")(
    function*(
      projectId: string,
      artifactId: string,
      versionId: string,
    ): Effect.fn.Return<ArtifactVersion, VersionNotFound | ArtifactRepositoryFailure> {
      const version = yield* dependencies.repository.findVersionRecord(
        projectId,
        artifactId,
        versionId,
      );
      if (version !== null) return version;
      return yield* new VersionNotFound({
        message: "The saved version does not exist on this artifact.",
      });
    },
  );

  const getArtifact = Effect.fn("ArtifactManagementService.getArtifact")(
    function*(command: ReadArtifactCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireVisibleWithGrants(dependencies.grants, command.principal, artifact);
      yield* authorization.requireArtifactRead(command.principal);
      const current = yield* requireVersion(
        project.id,
        artifact.id,
        artifact.currentVersionId,
      );
      return {artifact, current};
    },
  );

  const getArtifactWithOwnerName = Effect.fn(
    "ArtifactManagementService.getArtifactWithOwnerName",
  )(function*(command: ReadArtifactCommand) {
    const details = yield* getArtifact(command);
    const names = yield* displayNames(command.principal, [details.artifact.ownerPrincipalId]);
    return {...details, ownerDisplayName: nameOf(names, details.artifact.ownerPrincipalId)};
  });

  const getVersionDetails = Effect.fn("ArtifactManagementService.getVersionDetails")(
    function*(command: ReadArtifactVersionCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      // The artifact and version reads are independent, so they run in one
      // round of concurrent queries; existence and authorization checks keep
      // their original order below.
      const [artifact, version] = yield* Effect.all([
        dependencies.repository.findArtifact(project.id, command.artifactId),
        dependencies.repository.findVersionRecord(
          project.id,
          command.artifactId,
          command.versionId,
        ),
      ], {concurrency: 2});
      if (artifact === null) {
        return yield* new ArtifactNotFound({message: "The artifact does not exist."});
      }
      yield* requireVisibleWithGrants(dependencies.grants, command.principal, artifact);
      yield* authorization.requireArtifactRead(command.principal);
      if (version === null) {
        return yield* new VersionNotFound({
          message: "The saved version does not exist on this artifact.",
        });
      }
      return {artifact, saved: version};
    },
  );

  const getVersion = Effect.fn("ArtifactManagementService.getVersion")(
    function*(command: ReadArtifactVersionCommand) {
      const details = yield* getVersionDetails(command);
      return details.saved;
    },
  );

  const listVersions = Effect.fn("ArtifactManagementService.listVersions")(
    function*(command: ReadArtifactCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      // The artifact read and the version listing are independent, so they
      // run concurrently; existence and authorization checks keep their
      // original order below.
      const [artifact, versions] = yield* Effect.all([
        dependencies.repository.findArtifact(project.id, command.artifactId),
        dependencies.repository.listArtifactVersions(
          project.id,
          command.artifactId,
        ),
      ], {concurrency: 2});
      if (artifact === null) {
        return yield* new ArtifactNotFound({message: "The artifact does not exist."});
      }
      yield* requireVisibleWithGrants(dependencies.grants, command.principal, artifact);
      yield* authorization.requireArtifactRead(command.principal);
      return versions;
    },
  );

  const listArtifacts = Effect.fn("ArtifactManagementService.listArtifacts")(
    function*(command: ListArtifactsCommand) {
      const limit = yield* requirePageSize(command.limit);
      const comments = command.comments ?? "all";
      const sort = command.sort ?? "newest";
      if (sort === "comments" && command.cursor !== null && command.cursor.rank === undefined) {
        return yield* new InvalidPagination({
          message: "The artifact page cursor does not match the selected sort.",
        });
      }
      yield* authorization.requireArtifactListing(command.principal);
      const tags = yield* parseArtifactTags(command.tags);
      const search = normalizeArtifactSearch(command.search);
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      // Only members are granted, so nothing is shared with a service principal.
      if (command.scope === "shared_with_me" && command.principal.kind !== principalKinds.human) {
        return {items: [], nextCursor: null};
      }
      return yield* dependencies.repository.listArtifacts({
        comments,
        cursor: command.cursor,
        limit,
        ownerPrincipalId: command.scope === "mine" ? command.principal.id : null,
        sharedWithPrincipalId: command.scope === "shared_with_me" ? command.principal.id : null,
        projectId: project.id,
        restrictedScope: restrictedArtifactScope(command.principal),
        search,
        sort,
        tags,
      });
    },
  );

  const listArtifactsWithOwnerNames = Effect.fn(
    "ArtifactManagementService.listArtifactsWithOwnerNames",
  )(function*(command: ListArtifactsCommand) {
    const page = yield* listArtifacts(command);
    const names = yield* displayNames(
      command.principal,
      page.items.map((item) => item.ownerPrincipalId),
    );
    return {
      items: page.items.map((item) => ({
        ...item,
        ownerDisplayName: nameOf(names, item.ownerPrincipalId),
      })),
      nextCursor: page.nextCursor,
    };
  });

  const listArtifactActions = Effect.fn(
    "ArtifactManagementService.listArtifactActions",
  )(function*(command: ListArtifactActionsCommand) {
    const limit = yield* requirePageSize(command.limit);
    const project = yield* resolveProjectForRead(
      command.principal,
      command.projectId,
    );
    const artifact = yield* requireArtifactForAdministration(
      project.id,
      command.artifactId,
    );
    yield* requireVisibleWithGrants(dependencies.grants, command.principal, artifact);
    yield* authorization.requireArtifactManagement(command.principal);
    const page = yield* dependencies.repository.listArtifactActions({
      artifactId: artifact.id,
      cursor: command.cursor,
      limit,
      projectId: project.id,
    });
    const names = yield* displayNames(
      command.principal,
      page.items.map((action) => action.principalId),
    );
    return {
      items: page.items.map((action) => ({
        ...action,
        actorDisplayName: nameOf(names, action.principalId),
      })),
      nextCursor: page.nextCursor,
    };
  });

  // Who sees an artifact is the owner's or an administrator's decision; anyone
  // else who can see it gets the same refusal as for its access setting.
  const requireGrantManagement = Effect.fn(
    "ArtifactManagementService.requireGrantManagement",
  )(function*(command: ReadArtifactCommand) {
    const project = yield* resolveProjectForRead(
      command.principal,
      command.projectId,
    );
    const artifact = yield* requireArtifact(project.id, command.artifactId);
    yield* requireVisibleWithGrants(dependencies.grants, command.principal, artifact);
    // Like an access change: an API key also needs the management capability.
    yield* authorization.requireArtifactManagement(command.principal);
    if (!mayChangeRestriction(command.principal, artifact)) {
      return yield* new AuthorizationDenied({
        message: "Only the owner or an administrator can change who sees this artifact.",
      });
    }
    return artifact;
  });

  const getGrants = Effect.fn("ArtifactManagementService.getGrants")(
    function*(command: ReadArtifactCommand) {
      const artifact = yield* requireGrantManagement(command);
      return yield* dependencies.repository.listArtifactGrants(
        artifact.projectId,
        artifact.id,
      );
    },
  );

  const getGrantsForViewer = Effect.fn("ArtifactManagementService.getGrantsForViewer")(
    function*(command: ReadArtifactCommand) {
      return yield* getGrants(command).pipe(
        Effect.catchTag("AuthorizationDenied", () => Effect.succeed(null)),
      );
    },
  );

  const changeGrants = Effect.fn("ArtifactManagementService.changeGrants")(
    function*(command: ChangeArtifactGrantsCommand) {
      const artifact = yield* requireGrantManagement(command);
      const add = yield* parseGrantees(command.add);
      const remove = yield* parseGrantees(command.remove);
      if (add.some((email) => remove.includes(email))) {
        return yield* new InvalidArtifactGrant({
          message: "An address cannot be added and removed in the same change.",
        });
      }
      const changedAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.changeArtifactGrants({
        add,
        artifactId: artifact.id,
        changedAt,
        principalId: command.principal.id,
        projectId: artifact.projectId,
        remove,
      });
    },
  );

  const restoreVersion = Effect.fn("ArtifactManagementService.restoreVersion")(
    function*(command: RestoreArtifactVersionCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireVisibleWithGrants(dependencies.grants, command.principal, artifact);
      // A grantee sees a restricted artifact but never manages it.
      yield* requireRestrictedManagement(command.principal, artifact);
      yield* authorization.requireArtifactManagement(command.principal);
      yield* requireVersion(project.id, artifact.id, command.versionId);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.restoreVersion({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "restore",
          principalId: command.principal.id,
          projectId: project.id,
          value: command.versionId,
        }),
        principalId: command.principal.id,
        projectId: project.id,
        versionId: command.versionId,
      });
    },
  );

  const changeAccess = Effect.fn("ArtifactManagementService.changeAccess")(
    function*(command: ChangeArtifactAccessCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireVisibleWithGrants(dependencies.grants, command.principal, artifact);
      yield* requireRestrictedManagement(command.principal, artifact);
      yield* authorization.requireArtifactManagement(command.principal);
      // Only the owner or an administrator moves an artifact to or from restricted.
      if (
        (artifact.accessSetting === accessSettings.restricted ||
          command.accessSetting === accessSettings.restricted) &&
        !mayChangeRestriction(command.principal, artifact)
      ) {
        return yield* new AuthorizationDenied({
          message: "Only the owner or an administrator can change who sees this artifact.",
        });
      }
      // Moving away from a public link stays allowed, so administrators can
      // clean up links made before the switch was turned off.
      yield* requireAccessSettingAllowed(
        command.accessSetting,
        dependencies.publicLinks,
      );
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      const state = yield* dependencies.repository.changeAccessSetting({
        accessSetting: command.accessSetting,
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "change_access",
          principalId: command.principal.id,
          projectId: project.id,
          value: command.accessSetting,
        }),
        principalId: command.principal.id,
        projectId: project.id,
      });
      // The repository read the replaced setting inside its transaction, so a
      // change committed after the read above is not missed.
      const replaced = state.previousAccessSetting ?? accessSettings.publicLink;
      const mayHaveEndedPublicLink =
        isPubliclyReadable(replaced, dependencies.publicLinks) &&
        !isPubliclyReadable(command.accessSetting, dependencies.publicLinks);
      return {...state, mayHaveEndedPublicLink};
    },
  );

  const changeTags = Effect.fn("ArtifactManagementService.changeTags")(
    function*(command: ChangeArtifactTagsCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireVisibleWithGrants(dependencies.grants, command.principal, artifact);
      yield* requireRestrictedManagement(command.principal, artifact);
      yield* authorization.requireArtifactManagement(command.principal);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const tags = yield* parseArtifactTags(command.tags);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.changeTags({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "change_tags",
          principalId: command.principal.id,
          projectId: project.id,
          value: JSON.stringify(tags),
        }),
        principalId: command.principal.id,
        projectId: project.id,
        tags,
      });
    },
  );

  const deleteArtifact = Effect.fn("ArtifactManagementService.deleteArtifact")(
    function*(command: DeleteArtifactCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifactForAdministration(
        project.id,
        command.artifactId,
      );
      yield* requireVisibleWithGrants(dependencies.grants, command.principal, artifact);
      yield* requireRestrictedManagement(command.principal, artifact);
      yield* authorization.requireArtifactManagement(command.principal);
      // A delete cannot be undone, so it stays with the owner and administrators.
      if (!isOwnerOrHumanAdministrator(command.principal, artifact)) {
        return yield* new AuthorizationDenied({
          message: "Only the owner or an administrator can delete this artifact.",
        });
      }
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.deleteArtifact({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "delete",
          principalId: command.principal.id,
          projectId: project.id,
          value: artifact.id,
        }),
        principalId: command.principal.id,
        projectId: project.id,
      });
    },
  );

  return ArtifactManagementService.of({
    changeAccess,
    changeGrants,
    changeTags,
    deleteArtifact,
    getArtifact,
    getArtifactWithOwnerName,
    getGrants,
    getGrantsForViewer,
    getVersion,
    getVersionDetails,
    listArtifactActions,
    listArtifacts,
    listArtifactsWithOwnerNames,
    listVersions,
    restoreVersion,
  });
}

/** Parse grant addresses into their stored form, dropping repeats; fail on the first malformed one. */
const parseGrantees = Effect.fn("ArtifactManagementService.parseGrantees")(
  function*(values: readonly string[]) {
    const normalized = new Set<string>();
    for (const value of values) {
      const email = parseEmailAddress(value);
      if (email === null) {
        return yield* new InvalidArtifactGrant({
          message: `"${value.trim().slice(0, 80)}" is not a valid email address.`,
        });
      }
      normalized.add(email);
    }
    return [...normalized];
  },
);

interface ManagementInputDigest {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly operation:
    | "change_access"
    | "change_tags"
    | "delete"
    | "restore";
  readonly principalId: string;
  readonly projectId: string;
  readonly value: string;
}

function managementInputDigest(input: ManagementInputDigest): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function nameOf(
  names: ReadonlyMap<string, string>,
  principalId: string | null,
): string | null {
  return principalId === null ? null : names.get(principalId) ?? null;
}
