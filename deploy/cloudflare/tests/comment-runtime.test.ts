import {createHash} from "node:crypto";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {stateQueries} from "../src/recovery-worker.js";

const apiToken = "cloudflare-comment-test-api-token-00000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({
    path: z.string(),
    uploadUrl: z.url(),
  })).length(1),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
const commentAuthorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: z.enum(["human", "service"]),
});
const commentThreadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  path: z.string().nullable(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.iso.datetime(),
  versionId: z.string(),
}).loose();
const commentReplySchema = z.object({
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  threadId: z.string(),
}).loose();
const threadCreationSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
}).strict();
const threadEnvelopeSchema = z.object({thread: commentThreadSchema}).strict();
const replyCreationSchema = z.object({
  replayed: z.boolean(),
  reply: commentReplySchema,
}).strict();
const threadDetailsSchema = z.object({
  replies: z.array(commentReplySchema),
  thread: commentThreadSchema,
}).strict();
const threadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).strict();
const actionListSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    id: z.string(),
    idempotencyKey: z.string(),
  }).loose()),
}).loose();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();
const schemaVersionRowSchema = z.object({version: z.number().int().positive()});
const tableColumnRowSchema = z.object({name: z.string()});
const loginAttemptRowSchema = z.object({
  codeVerifier: z.string(),
  nonce: z.string().nullable(),
});

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(join(tmpdir(), "artifact-server-cloudflare-comments-"));
  worker = await startWorker(persistPath);
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare D1 comments", () => {
  it("records the whole comment lifecycle and keeps it across a restart", async () => {
    const published = await publishArtifact(worker, "comment-lifecycle-publish");
    const artifactId = published.artifact.id;
    const threadsUrl = `${origin}/api/v1/artifacts/${artifactId}/comments`;
    const createUrl =
      `${origin}/api/v1/artifacts/${artifactId}/versions/${published.version.id}/comments`;

    const unknownPath = await worker.fetch(createUrl, {
      body: JSON.stringify({body: "Not a real file.", path: "missing.html"}),
      headers: mutationHeaders("comment-unknown-path-000001"),
      method: "POST",
    });
    expect(unknownPath.status).toBe(422);
    expect(failureSchema.parse(await unknownPath.json()).error.code)
      .toBe("INVALID_COMMENT");

    const anchor = {kind: "page", point: {x: 0.25, y: 0.5}};
    const createdResponse = await worker.fetch(createUrl, {
      body: JSON.stringify({
        anchor,
        body: "The axis label is wrong.",
        path: "index.html",
      }),
      headers: mutationHeaders("comment-create-thread-00001"),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const created = threadCreationSchema.parse(await createdResponse.json());
    expect(created.replayed).toBe(false);
    expect(created.thread.versionId).toBe(published.version.id);
    expect(created.thread.anchor).toEqual(anchor);
    expect(created.thread.author.displayName).toBe("Local");
    expect(created.thread.replyCount).toBe(0);
    const threadId = created.thread.id;

    const replayResponse = await worker.fetch(createUrl, {
      body: JSON.stringify({
        anchor,
        body: "The axis label is wrong.",
        path: "index.html",
      }),
      headers: mutationHeaders("comment-create-thread-00001"),
      method: "POST",
    });
    expect(replayResponse.status).toBe(201);
    expect(threadCreationSchema.parse(await replayResponse.json()))
      .toMatchObject({replayed: true, thread: {id: threadId}});

    const conflict = await worker.fetch(createUrl, {
      body: JSON.stringify({body: "Different words entirely."}),
      headers: mutationHeaders("comment-create-thread-00001"),
      method: "POST",
    });
    expect(conflict.status).toBe(409);
    expect(failureSchema.parse(await conflict.json()).error.code)
      .toBe("IDEMPOTENCY_CONFLICT");

    const replyResponse = await worker.fetch(`${threadsUrl}/${threadId}/replies`, {
      body: JSON.stringify({body: "Corrected in the next version."}),
      headers: mutationHeaders("comment-create-reply-000001"),
      method: "POST",
    });
    expect(replyResponse.status).toBe(201);
    const reply = replyCreationSchema.parse(await replyResponse.json());
    expect(reply.replayed).toBe(false);
    const replayedReply = await worker.fetch(`${threadsUrl}/${threadId}/replies`, {
      body: JSON.stringify({body: "Corrected in the next version."}),
      headers: mutationHeaders("comment-create-reply-000001"),
      method: "POST",
    });
    expect(replyCreationSchema.parse(await replayedReply.json())).toMatchObject({
      replayed: true,
      reply: {id: reply.reply.id},
    });

    const detail = await readThread(worker, threadsUrl, threadId);
    expect(detail.replies.map((stored) => stored.id)).toEqual([reply.reply.id]);
    expect(detail.thread.replyCount).toBe(1);

    const resolved = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {state: "resolved"},
    );
    expect(resolved.status).toBe(200);
    expect(threadEnvelopeSchema.parse(await resolved.json()).thread)
      .toMatchObject({
        body: "The axis label is wrong.",
        resolvedBy: {displayName: "Local", principalKind: "service"},
        state: "resolved",
      });

    const refused = await worker.fetch(`${threadsUrl}/${threadId}/replies`, {
      body: JSON.stringify({body: "Too late to answer."}),
      headers: mutationHeaders("comment-refused-reply-00001"),
      method: "POST",
    });
    expect(refused.status).toBe(409);
    expect(failureSchema.parse(await refused.json()).error.code)
      .toBe("COMMENT_RESOLVED");
    expect((await readThread(worker, threadsUrl, threadId)).replies)
      .toHaveLength(1);

    const reopened = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {state: "open"},
    );
    expect(reopened.status).toBe(200);
    expect(threadEnvelopeSchema.parse(await reopened.json()).thread)
      .toMatchObject({resolvedAt: null, resolvedBy: null, state: "open"});

    // Back-to-back state changes can share a millisecond. Each one must append
    // its own ledger row, so the derived action key cannot be the timestamp.
    const burst = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {state: "resolved"},
    );
    expect(burst.status).toBe(200);
    const burstReopen = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {state: "open"},
    );
    expect(burstReopen.status).toBe(200);

    const edited = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {body: "The axis label reads 2024."},
    );
    expect(threadEnvelopeSchema.parse(await edited.json()).thread).toMatchObject({
      anchor,
      body: "The axis label reads 2024.",
      state: "open",
    });

    const replyEdit = await patchThread(
      worker,
      `${threadsUrl}/${threadId}/replies/${reply.reply.id}`,
      {body: "Corrected in version two."},
    );
    expect(replyEdit.status).toBe(200);
    expect(z.object({reply: commentReplySchema}).strict()
      .parse(await replyEdit.json()).reply.body)
      .toBe("Corrected in version two.");

    const secondResponse = await worker.fetch(createUrl, {
      body: JSON.stringify({body: "The footnote has no source."}),
      headers: mutationHeaders("comment-create-thread-00002"),
      method: "POST",
    });
    expect(secondResponse.status).toBe(201);
    const secondId = threadCreationSchema.parse(await secondResponse.json())
      .thread.id;
    expect((await patchThread(
      worker,
      `${threadsUrl}/${secondId}`,
      {state: "resolved"},
    )).status).toBe(200);

    const listed = threadPageSchema.parse(
      await (await authenticatedFetch(worker, threadsUrl)).json(),
    );
    expect(listed.items.map(({id}) => id).toSorted())
      .toEqual([secondId, threadId].toSorted());
    const artifactCatalog = z.object({
      artifacts: z.array(z.object({
        artifact: z.object({id: z.string()}),
        commentCount: z.number().int().nonnegative(),
      })),
    }).parse(await (await authenticatedFetch(
      worker,
      `${origin}/api/v1/artifacts`,
    )).json());
    expect(artifactCatalog.artifacts.find(({artifact}) => artifact.id === artifactId))
      .toMatchObject({commentCount: 2});
    const commentedCatalog = z.object({
      artifacts: z.array(z.object({
        artifact: z.object({id: z.string()}),
        commentCount: z.number().int().positive(),
      })),
    }).parse(await (await authenticatedFetch(
      worker,
      `${origin}/api/v1/artifacts?comments=with&sort=comments&limit=1`,
    )).json());
    expect(commentedCatalog.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({id: artifactId}),
        commentCount: 2,
      }),
    ]);
    const uncommentedCatalog = z.object({artifacts: z.array(z.unknown())})
      .parse(await (await authenticatedFetch(
        worker,
        `${origin}/api/v1/artifacts?comments=without`,
      )).json());
    expect(uncommentedCatalog.artifacts).toEqual([]);

    const openOnly = threadPageSchema.parse(
      await (await authenticatedFetch(worker, `${threadsUrl}?state=open`)).json(),
    );
    expect(openOnly.items.map(({id}) => id)).toEqual([threadId]);

    const firstPage = threadPageSchema.parse(
      await (await authenticatedFetch(worker, `${threadsUrl}?limit=1`)).json(),
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = threadPageSchema.parse(await (await authenticatedFetch(
      worker,
      `${threadsUrl}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
    )).json());
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].map(({id}) => id).toSorted())
      .toEqual([secondId, threadId].toSorted());

    const future = threadPageSchema.parse(await (await authenticatedFetch(
      worker,
      `${threadsUrl}?since=${encodeURIComponent("2999-01-01T00:00:00.000Z")}`,
    )).json());
    expect(future.items).toHaveLength(0);

    const ledger = actionListSchema.parse(await (await authenticatedFetch(
      worker,
      `${origin}/api/v1/artifacts/${artifactId}/actions?limit=100`,
    )).json());
    const commentActions = ledger.actions
      .filter(({action}) => action.startsWith("comment_"));
    expect(commentActions.filter(({action}) => action === "comment_resolve"))
      .toHaveLength(3);
    expect(commentActions.filter(({action}) => action === "comment_reopen"))
      .toHaveLength(2);
    expect(new Set(commentActions.map(({idempotencyKey}) => idempotencyKey)).size)
      .toBe(commentActions.length);
    const derived = commentActions.filter(({action}) =>
      action !== "comment_create" && action !== "comment_reply"
    );
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((record) =>
      record.idempotencyKey.endsWith(`:${record.id}`)
    )).toBe(true);

    const replyDeleted = await worker.fetch(
      `${threadsUrl}/${threadId}/replies/${reply.reply.id}`,
      {headers: bearerHeaders(), method: "DELETE"},
    );
    expect(replyDeleted.status).toBe(204);
    expect((await readThread(worker, threadsUrl, threadId)).thread.replyCount)
      .toBe(0);
    const replyDeletedAgain = await worker.fetch(
      `${threadsUrl}/${threadId}/replies/${reply.reply.id}`,
      {headers: bearerHeaders(), method: "DELETE"},
    );
    expect(replyDeletedAgain.status).toBe(404);

    const threadDeleted = await worker.fetch(`${threadsUrl}/${threadId}`, {
      headers: bearerHeaders(),
      method: "DELETE",
    });
    expect(threadDeleted.status).toBe(204);
    const gone = await authenticatedFetch(worker, `${threadsUrl}/${threadId}`);
    expect(gone.status).toBe(404);
    expect(failureSchema.parse(await gone.json()).error.code)
      .toBe("COMMENT_NOT_FOUND");

    await worker.stop();
    worker = await startWorker(persistPath);
    const afterRestart = threadPageSchema.parse(
      await (await authenticatedFetch(worker, threadsUrl)).json(),
    );
    expect(afterRestart.items.map(({id}) => id)).toEqual([secondId]);
    expect(afterRestart.items[0]?.state).toBe("resolved");
  }, 120_000);

  it("AUTH-035 AUTH-036: names owners from D1 members and service keys, lists only the caller's own artifacts with scope=mine, and lets only the owner delete", async () => {
    const namesDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-names-"),
    );
    let namesWorker = await startWorker(namesDirectory);
    try {
      const byAda = await publishArtifact(namesWorker, "names-ada-publish-0001");
      const byBot = await publishArtifact(namesWorker, "names-bot-publish-0001");
      const own = await publishArtifact(namesWorker, "names-own-publish-0001");
      await namesWorker.stop();

      // Hand two artifacts to a member and a rotated service key that only
      // exist in the D1 identity tables.
      const database = new DatabaseSync(await findD1DatabaseFile(namesDirectory));
      try {
        const {installationId} = z.object({installationId: z.string()}).parse(
          database.prepare(
            "SELECT installation_id AS installationId FROM projects LIMIT 1",
          ).get(),
        );
        database.prepare(`
          INSERT INTO installation_members
            (id, installation_id, email, display_name, role, status, created_at, updated_at)
          VALUES ('member_ada', ?, 'ada@example.test', 'Ada Lovelace', 'member', 'inactive', ?, ?)
        `).run(installationId, "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
        const insertKey = database.prepare(`
          INSERT INTO managed_api_keys
            (id, installation_id, name, prefix, secret_digest, principal_id, principal_kind,
             capabilities_json, authorized_by_principal_id, created_at, expires_at)
          VALUES (?, ?, ?, ?, 'digest', 'service_bot', 'service', '[]', 'member_ada', ?, ?)
        `);
        insertKey.run("key_old", installationId, "Old bot name", "prefix_old",
          "2026-11-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
        insertKey.run("key_new", installationId, "Release bot", "prefix_new",
          "2026-11-03T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
        const handOver = database.prepare(
          "UPDATE artifacts SET owner_principal_id = ? WHERE id = ?",
        );
        handOver.run("member_ada", byAda.artifact.id);
        handOver.run("service_bot", byBot.artifact.id);
      } finally {
        database.close();
      }

      namesWorker = await startWorker(namesDirectory);
      const listSchema = z.object({
        artifacts: z.array(z.object({
          artifact: z.object({id: z.string()}),
          ownerDisplayName: z.string().nullable(),
        })),
      });
      const listed = listSchema.parse(await (await authenticatedFetch(
        namesWorker,
        `${origin}/api/v1/artifacts`,
      )).json());
      expect(Object.fromEntries(listed.artifacts.map(({artifact, ownerDisplayName}) => [
        artifact.id,
        ownerDisplayName,
      ]))).toEqual({
        [byAda.artifact.id]: "Ada Lovelace",
        [byBot.artifact.id]: "Release bot",
        [own.artifact.id]: null,
      });
      const details = z.object({ownerDisplayName: z.string().nullable()}).parse(
        await (await authenticatedFetch(
          namesWorker,
          `${origin}/api/v1/artifacts/${byAda.artifact.id}`,
        )).json(),
      );
      expect(details.ownerDisplayName).toBe("Ada Lovelace");
      const mine = listSchema.parse(await (await authenticatedFetch(
        namesWorker,
        `${origin}/api/v1/artifacts?scope=mine`,
      )).json());
      expect(mine.artifacts.map(({artifact}) => artifact.id)).toEqual([own.artifact.id]);

      const deleteWithDefaultToken = (artifact: typeof own) =>
        namesWorker.fetch(`${origin}/api/v1/artifacts/${artifact.artifact.id}`, {
          body: JSON.stringify({expectedCurrentVersionId: artifact.version.id}),
          headers: mutationHeaders(`names-delete-${artifact.artifact.id}`),
          method: "DELETE",
        });
      const refused = await deleteWithDefaultToken(byAda);
      expect(refused.status).toBe(403);
      expect(failureSchema.parse(await refused.json()).error.code)
        .toBe("AUTHORIZATION_DENIED");
      expect((await deleteWithDefaultToken(own)).status).toBe(200);
    } finally {
      await namesWorker.stop();
      await rm(namesDirectory, {force: true, recursive: true});
    }
  }, 120_000);

  it("AUTH-037 AUTH-038 AUTH-039: D1 adds the grant table on upgrade, shares a restricted artifact with members by email, holds the cap, ends access on removal, and records one sharing row per real change", async () => {
    const grantsDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-grants-"),
    );
    let grantsWorker = await startWorker(grantsDirectory);
    try {
      const target = await publishArtifact(grantsWorker, "grants-target-publish-1");
      await grantsWorker.stop();

      // Members and their keys exist only in D1; Ada owns the restricted page,
      // and the database is rewound to the revision before grants.
      const d1File = await findD1DatabaseFile(grantsDirectory);
      const ada = memberKey("ada");
      const ben = memberKey("ben");
      const carl = memberKey("carl");
      const dan = memberKey("dan");
      const database = new DatabaseSync(d1File);
      try {
        const {installationId} = z.object({installationId: z.string()}).parse(
          database.prepare(
            "SELECT installation_id AS installationId FROM projects LIMIT 1",
          ).get(),
        );
        const insertMember = database.prepare(`
          INSERT INTO installation_members
            (id, installation_id, email, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')
        `);
        const insertKey = database.prepare(`
          INSERT INTO managed_api_keys
            (id, installation_id, name, prefix, secret_digest, principal_id, principal_kind,
             capabilities_json, authorized_by_principal_id, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, 'human', ?, ?, '2026-11-10T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
        `);
        for (const member of [ada, ben, carl, dan]) {
          insertMember.run(
            member.memberId,
            installationId,
            member.email,
            member.name,
            member === dan ? "administrator" : "member",
          );
          insertKey.run(
            member.keyId,
            installationId,
            `${member.name}'s key`,
            member.keyId,
            createHash("sha256").update(member.token).digest("hex"),
            member.memberId,
            JSON.stringify([
              "artifact:create",
              "artifact:manage:any",
              "artifact:publish:any",
              "artifact:read",
              "comment:write",
              "content-session:issue",
            ]),
            member.memberId,
          );
        }
        database.prepare("UPDATE artifacts SET owner_principal_id = ?, restricted = 1 WHERE id = ?")
          .run(ada.memberId, target.artifact.id);
        database.exec(`
          DROP TABLE artifact_grants;
          ALTER TABLE actions DROP COLUMN grantee;
          UPDATE artifact_server_schema SET version = 11 WHERE component = 'runtime';
        `);
      } finally {
        database.close();
      }

      grantsWorker = await startWorker(grantsDirectory);
      const artifactUrl = `${origin}/api/v1/artifacts/${target.artifact.id}`;
      const as = (
        member: MemberKey,
        url: string,
        request: {readonly body?: string; readonly idempotencyKey?: string; readonly method?: string} = {},
      ) => {
        const headers: [string, string][] = [
          ["Authorization", `Bearer ${member.token}`],
          ["Content-Type", "application/json"],
        ];
        if (request.idempotencyKey !== undefined) headers.push(["Idempotency-Key", request.idempotencyKey]);
        return grantsWorker.fetch(url, {
          body: request.body ?? null,
          headers,
          method: request.method ?? "GET",
        });
      };
      const changeGrants = (
        member: MemberKey,
        change: {readonly add?: readonly string[]; readonly remove?: readonly string[]},
      ) => as(member, `${artifactUrl}/grants`, {body: JSON.stringify(change), method: "PATCH"});
      const grantSchema = z.object({
        active: z.boolean(),
        grants: z.array(z.object({grantee: z.string(), kind: z.literal("email")})),
      });

      // The Worker migrates on its first request.
      expect((await as(ben, artifactUrl)).status).toBe(404);
      const upgraded = new DatabaseSync(d1File, {readOnly: true});
      try {
        expect(schemaVersionRowSchema.parse(upgraded.prepare(
          "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
        ).get()).version).toBe(13);
        expect(upgraded.prepare("PRAGMA table_info(artifact_grants)").all()).toHaveLength(5);
        // Revision 13 rebuilt the action table with a grantee column and kept its rows.
        expect(z.array(z.object({name: z.string()})).parse(upgraded.prepare("PRAGMA table_info(actions)").all())
          .map(({name}) => name)).toContain("grantee");
        expect(z.array(z.object({action: z.string(), grantee: z.null()})).parse(upgraded.prepare(
          "SELECT action, grantee FROM actions WHERE artifact_id = ?",
        ).all(target.artifact.id))).toContainEqual({action: "publish", grantee: null});
        // The recovery check reads every table, so a restore that loses grants fails.
        const tables = z.array(z.object({name: z.string()})).parse(upgraded.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'
          ORDER BY name
        `).all()).map(({name}) => name);
        expect(stateQueries.map(({name}) => name).toSorted()).toStrictEqual(tables);
      } finally {
        upgraded.close();
      }

      const sharingRows = () => {
        const reader = new DatabaseSync(d1File, {readOnly: true});
        try {
          return z.array(z.object({
            action: z.string(),
            authorizedByPrincipalId: z.string().nullable(),
            grantee: z.string(),
            principalId: z.string(),
          })).parse(reader.prepare(`
            SELECT action, authorized_by_principal_id AS authorizedByPrincipalId, grantee,
                   principal_id AS principalId
            FROM actions WHERE artifact_id = ? AND action IN ('grant_add', 'grant_remove')
            ORDER BY action, grantee
          `).all(target.artifact.id));
        } finally {
          reader.close();
        }
      };
      const sharingRow = (action: string, grantee: string) => ({
        action,
        authorizedByPrincipalId: ada.memberId,
        grantee,
        principalId: ada.memberId,
      });

      const granted = await changeGrants(ada, {add: [" Ben@Example.test "]});
      expect(granted.status).toBe(200);
      expect(sharingRows()).toStrictEqual([sharingRow("grant_add", "ben@example.test")]);
      expect(grantSchema.parse(await granted.json())).toStrictEqual({
        active: true,
        grants: [{grantee: "ben@example.test", kind: "email"}],
      });
      expect((await as(ben, artifactUrl)).status).toBe(200);
      expect((await as(carl, artifactUrl)).status).toBe(404);
      const shared = z.object({
        artifacts: z.array(z.object({artifact: z.object({id: z.string()})})),
      }).parse(await (await as(ben, `${origin}/api/v1/artifacts?scope=shared_with_me`)).json());
      expect(shared.artifacts.map(({artifact}) => artifact.id)).toStrictEqual([target.artifact.id]);
      expect((await as(ben, `${artifactUrl}/grants`)).status).toBe(403);

      // One change above the cap fails as a whole and changes nothing.
      const tooMany = await changeGrants(ada, {
        add: Array.from({length: 100}, (_, index) => `person${index}@example.test`),
      });
      expect(tooMany.status).toBe(409);
      expect(failureSchema.parse(await tooMany.json()).error.code).toBe("GRANT_LIMIT_REACHED");
      expect(grantSchema.parse(await (await as(ada, `${artifactUrl}/grants`)).json()).grants
        .map(({grantee}) => grantee)).toStrictEqual(["ben@example.test"]);
      expect(sharingRows()).toStrictEqual([sharingRow("grant_add", "ben@example.test")]);

      const openContentAccess = (member: MemberKey): number => {
        const reader = new DatabaseSync(d1File, {readOnly: true});
        try {
          return z.object({total: z.number()}).parse(reader.prepare(`
            SELECT (SELECT COUNT(*) FROM content_sessions WHERE principal_id = ? AND artifact_id = ?)
              + (SELECT COUNT(*) FROM content_bootstraps WHERE principal_id = ? AND artifact_id = ?) AS total
          `).get(member.memberId, target.artifact.id, member.memberId, target.artifact.id)).total;
        } finally {
          reader.close();
        }
      };

      // Removing the grant ends Ben's open content access at once; removing the
      // owner's own address keeps the owner's.
      expect((await as(ben, `${artifactUrl}/content-sessions`, {method: "POST"})).status).toBe(201);
      expect((await as(ada, `${artifactUrl}/content-sessions`, {method: "POST"})).status).toBe(201);
      expect((await changeGrants(ada, {remove: ["ben@example.test", ada.email]})).status).toBe(200);
      expect((await as(ben, artifactUrl)).status).toBe(404);
      expect(openContentAccess(ben)).toBe(0);
      expect(openContentAccess(ada)).toBeGreaterThan(0);
      // Ada's own address was never granted, so only Ben's removal is recorded.
      expect(sharingRows()).toStrictEqual([
        sharingRow("grant_add", "ben@example.test"),
        sharingRow("grant_remove", "ben@example.test"),
      ]);

      // Only the owner lists the sharing rows; a grantee pages past them.
      expect((await changeGrants(ada, {add: ["ben@example.test"]})).status).toBe(200);
      const activitySchema = z.object({
        actions: z.array(z.object({action: z.string(), grantee: z.string().nullable()})),
      });
      const activityOf = async (member: MemberKey) =>
        activitySchema.parse(await (await as(member, `${artifactUrl}/actions`)).json()).actions
          .filter(({grantee}) => grantee !== null)
          .map(({action}) => action)
          .toSorted();
      expect(await activityOf(ada)).toStrictEqual(["grant_add", "grant_add", "grant_remove"]);
      expect(await activityOf(ben)).toStrictEqual([]);

      // Switching to restricted ends an administrator's content access too: it
      // may come from a member-bound key, which cannot see a restricted artifact.
      const switchTo = (accessSetting: string, idempotencyKey: string) =>
        as(ada, `${artifactUrl}/access`, {
          body: JSON.stringify({accessSetting, expectedCurrentVersionId: target.version.id}),
          idempotencyKey,
          method: "PATCH",
        });
      expect((await switchTo("account_required", "grants-open-target-0001")).status).toBe(200);
      expect((await as(dan, `${artifactUrl}/content-sessions`, {method: "POST"})).status).toBe(201);
      expect((await switchTo("restricted", "grants-close-target-0001")).status).toBe(200);
      expect(openContentAccess(dan)).toBe(0);
      expect(openContentAccess(ada)).toBeGreaterThan(0);

      // Deleting the artifact removes the addresses it was shared with.
      expect((await changeGrants(ada, {add: ["dora@example.test"]})).status).toBe(200);
      expect((await as(ada, artifactUrl, {
        body: JSON.stringify({expectedCurrentVersionId: target.version.id}),
        idempotencyKey: "grants-delete-target-0001",
        method: "DELETE",
      })).status).toBe(200);
      const afterDelete = new DatabaseSync(d1File, {readOnly: true});
      try {
        expect(z.object({total: z.number()}).parse(afterDelete.prepare(
          "SELECT COUNT(*) AS total FROM artifact_grants WHERE artifact_id = ?",
        ).get(target.artifact.id)).total).toBe(0);
      } finally {
        afterDelete.close();
      }
    } finally {
      await grantsWorker.stop();
      await rm(grantsDirectory, {force: true, recursive: true});
    }
  }, 120_000);

  it("AUTH-035: names a page of owners larger than one D1 statement can bind parameters for", async () => {
    const manyDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-many-owners-"),
    );
    let manyWorker = await startWorker(manyDirectory);
    const ownerCount = 55;
    try {
      const published = await Promise.all(Array.from(
        {length: ownerCount},
        (_, index) => publishArtifact(
          manyWorker,
          `many-owners-publish-${String(index).padStart(4, "0")}`,
        ),
      ));
      await manyWorker.stop();

      // Each artifact gets its own member, so one page names 55 owners: more
      // than D1's 100 bound parameters if every id were its own placeholder.
      const database = new DatabaseSync(await findD1DatabaseFile(manyDirectory));
      try {
        const {installationId} = z.object({installationId: z.string()}).parse(
          database.prepare(
            "SELECT installation_id AS installationId FROM projects LIMIT 1",
          ).get(),
        );
        const admit = database.prepare(`
          INSERT INTO installation_members
            (id, installation_id, email, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'member', 'active', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')
        `);
        const handOver = database.prepare(
          "UPDATE artifacts SET owner_principal_id = ? WHERE id = ?",
        );
        for (const [index, publication] of published.entries()) {
          // Member 0 has its email as display name, as sign-in stores it when
          // the provider sends no name; it must not be shown.
          admit.run(
            `member_${index}`,
            installationId,
            `member-${index}@example.test`,
            index === 0 ? "Member-0@Example.test" : `Member ${index}`,
          );
          handOver.run(`member_${index}`, publication.artifact.id);
        }
      } finally {
        database.close();
      }

      manyWorker = await startWorker(manyDirectory);
      const response = await authenticatedFetch(
        manyWorker,
        `${origin}/api/v1/artifacts?limit=100`,
      );
      expect(response.status).toBe(200);
      const listed = z.object({
        artifacts: z.array(z.object({ownerDisplayName: z.string().nullable()})),
      }).parse(await response.json());
      expect(listed.artifacts).toHaveLength(ownerCount);
      expect(new Set(listed.artifacts.map(({ownerDisplayName}) => ownerDisplayName)))
        .toEqual(new Set(Array.from(
          {length: ownerCount},
          (_, index) => index === 0 ? null : `Member ${index}`,
        )));
    } finally {
      await manyWorker.stop();
      await rm(manyDirectory, {force: true, recursive: true});
    }
  }, 180_000);

  it("adds the staged upload grant column to a revision 9 database", async () => {
    const grantDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-grant-"),
    );
    let grantWorker = await startWorker(grantDirectory);
    try {
      expect((await authenticatedFetch(grantWorker, `${origin}/api/v1/artifacts`)).status)
        .toBe(200);
      await grantWorker.stop();
      const d1File = await findD1DatabaseFile(grantDirectory);
      const database = new DatabaseSync(d1File);
      try {
        database.exec(`
          ALTER TABLE staged_uploads DROP COLUMN grant_digest;
          UPDATE artifact_server_schema SET version = 9 WHERE component = 'runtime';
        `);
      } finally {
        database.close();
      }

      grantWorker = await startWorker(grantDirectory);
      expect((await authenticatedFetch(grantWorker, `${origin}/api/v1/artifacts`)).status)
        .toBe(200);
      const upgraded = new DatabaseSync(d1File, {readOnly: true});
      try {
        const columns = z.array(z.object({name: z.string()})).parse(
          upgraded.prepare("PRAGMA table_info(staged_uploads)").all(),
        );
        expect(columns.map(({name}) => name)).toContain("grant_digest");
      } finally {
        upgraded.close();
      }
    } finally {
      await grantWorker.stop();
      await rm(grantDirectory, {force: true, recursive: true});
    }
  }, 120_000);

  it("AUTH-034: warns about public copies only when an access change ends a public link", async () => {
    const warningDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-warning-"),
    );
    const warningWorker = await startWorker(warningDirectory);
    try {
      const published = await publishArtifact(warningWorker, "warning-publish-00001");
      const changeAccess = async (accessSetting: string, idempotencyKey: string) => {
        const response = await warningWorker.fetch(
          `${origin}/api/v1/artifacts/${published.artifact.id}/access`,
          {
            body: JSON.stringify({
              accessSetting,
              expectedCurrentVersionId: published.version.id,
            }),
            headers: mutationHeaders(idempotencyKey),
            method: "PATCH",
          },
        );
        expect(response.status).toBe(200);
        return z.object({warning: z.string().nullable()}).parse(await response.json())
          .warning;
      };
      expect(await changeAccess("public_link", "warning-make-public-0001")).toBeNull();
      expect(await changeAccess("account_required", "warning-end-public-0001"))
        .toContain("cannot be recalled");
      expect(await changeAccess("account_required", "warning-again-private-01"))
        .toBeNull();
    } finally {
      await warningWorker.stop();
      await rm(warningDirectory, {force: true, recursive: true});
    }
  }, 120_000);

  it("records owners, backfills them on upgrade, and hides restricted artifacts from other readers", async () => {
    const ownerDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-owner-"),
    );
    let ownerWorker = await startWorker(ownerDirectory);
    try {
      const kept = await publishArtifact(ownerWorker, "owner-kept-publish-0001");
      const shared = await publishArtifact(ownerWorker, "owner-shared-publish-01");
      const ownerOf = async (artifactId: string): Promise<string | null> => {
        const response = await authenticatedFetch(
          ownerWorker,
          `${origin}/api/v1/artifacts/${artifactId}`,
        );
        expect(response.status).toBe(200);
        return z.object({artifact: z.object({ownerPrincipalId: z.string().nullable()})})
          .parse(await response.json()).artifact.ownerPrincipalId;
      };
      const owner = await ownerOf(kept.artifact.id);
      expect(owner).not.toBeNull();
      await ownerWorker.stop();

      // An older D1 database has no owner column; the kept page was restricted
      // by its owner, whom the API token is not.
      const d1File = await findD1DatabaseFile(ownerDirectory);
      const database = new DatabaseSync(d1File);
      try {
        database.exec(`
          DROP INDEX artifacts_project_owner_active_created;
          ALTER TABLE artifacts DROP COLUMN owner_principal_id;
          UPDATE artifact_server_schema SET version = 10 WHERE component = 'runtime';
        `);
        database.prepare("UPDATE artifacts SET restricted = 1 WHERE id = ?")
          .run(kept.artifact.id);
      } finally {
        database.close();
      }

      ownerWorker = await startWorker(ownerDirectory);
      const listed = z.object({
        artifacts: z.array(z.object({artifact: z.object({id: z.string()})})),
      }).parse(await (await authenticatedFetch(
        ownerWorker,
        `${origin}/api/v1/artifacts`,
      )).json());
      expect(listed.artifacts.map(({artifact}) => artifact.id))
        .toEqual([shared.artifact.id]);
      const hidden = await authenticatedFetch(
        ownerWorker,
        `${origin}/api/v1/artifacts/${kept.artifact.id}`,
      );
      expect(hidden.status).toBe(404);
      expect(failureSchema.parse(await hidden.json()).error.code)
        .toBe("ARTIFACT_NOT_FOUND");
      expect(await ownerOf(shared.artifact.id)).toBe(owner);

      const upgraded = new DatabaseSync(d1File, {readOnly: true});
      try {
        expect(z.object({owner: z.string().nullable()}).parse(upgraded.prepare(
          "SELECT owner_principal_id AS owner FROM artifacts WHERE id = ?",
        ).get(kept.artifact.id)).owner).toBe(owner);
      } finally {
        upgraded.close();
      }
    } finally {
      await ownerWorker.stop();
      await rm(ownerDirectory, {force: true, recursive: true});
    }
  }, 120_000);

  it("upgrades a version 2 database in place and then accepts comments", async () => {
    const upgradeDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-upgrade-"),
    );
    let upgradeWorker = await startWorker(upgradeDirectory);
    try {
      const published = await publishArtifact(
        upgradeWorker,
        "comment-upgrade-publish-01",
      );
      await upgradeWorker.stop();

      const d1File = await findD1DatabaseFile(upgradeDirectory);
      const database = new DatabaseSync(d1File);
      try {
        database.exec(`
          DROP TABLE comment_replies;
          DROP TABLE comment_threads;
          CREATE TABLE actions_v2 (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            artifact_id TEXT NOT NULL REFERENCES artifacts(id),
            version_id TEXT NOT NULL REFERENCES versions(id),
            action TEXT NOT NULL CHECK (action IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
            principal_id TEXT NOT NULL,
            authorized_by_principal_id TEXT,
            idempotency_key TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO actions_v2 SELECT id, project_id, artifact_id, version_id,
            action, principal_id, authorized_by_principal_id, idempotency_key,
            created_at FROM actions;
          DROP TABLE actions;
          ALTER TABLE actions_v2 RENAME TO actions;
          UPDATE artifact_server_schema SET version = 2 WHERE component = 'runtime';
        `);
        expect(schemaVersionRowSchema.parse(database.prepare(
          "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
        ).get()).version).toBe(2);
      } finally {
        database.close();
      }

      upgradeWorker = await startWorker(upgradeDirectory);
      const ready = await upgradeWorker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(200);

      const preserved = actionListSchema.parse(await (await authenticatedFetch(
        upgradeWorker,
        `${origin}/api/v1/artifacts/${published.artifact.id}/actions`,
      )).json());
      expect(preserved.actions.map(({action}) => action)).toEqual(["publish"]);

      const created = await upgradeWorker.fetch(
        `${origin}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments`,
        {
          body: JSON.stringify({body: "Written after the schema upgrade."}),
          headers: mutationHeaders("comment-after-upgrade-0001"),
          method: "POST",
        },
      );
      expect(created.status).toBe(201);
      expect(threadCreationSchema.parse(await created.json()).thread.versionId)
        .toBe(published.version.id);

      const afterUpgrade = actionListSchema.parse(await (await authenticatedFetch(
        upgradeWorker,
        `${origin}/api/v1/artifacts/${published.artifact.id}/actions`,
      )).json());
      expect(afterUpgrade.actions.map(({action}) => action).toSorted())
        .toEqual(["comment_create", "publish"]);
    } finally {
      await upgradeWorker.stop();
      await rm(upgradeDirectory, {force: true, recursive: true});
    }
  }, 120_000);

  it("upgrades a version 3 database in place and keeps login attempts", async () => {
    const upgradeDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-nonce-"),
    );
    let upgradeWorker = await startWorker(upgradeDirectory);
    try {
      expect((await upgradeWorker.fetch(`${origin}/ready`)).status).toBe(200);
      await upgradeWorker.stop();

      const d1File = await findD1DatabaseFile(upgradeDirectory);
      const database = new DatabaseSync(d1File);
      try {
        database.exec(`
          DROP TABLE login_attempts;
          CREATE TABLE login_attempts (
            state_digest TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            code_verifier TEXT NOT NULL,
            return_to TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT
          );
          INSERT INTO login_attempts (
            state_digest, provider, code_verifier, return_to, created_at,
            expires_at, consumed_at
          ) VALUES (
            'version-three-state-digest', 'workos', 'version-three-verifier',
            '/', '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z', NULL
          );
          UPDATE artifact_server_schema SET version = 3 WHERE component = 'runtime';
        `);
      } finally {
        database.close();
      }

      upgradeWorker = await startWorker(upgradeDirectory);
      expect((await upgradeWorker.fetch(`${origin}/ready`)).status).toBe(200);
      await upgradeWorker.stop();

      const upgraded = new DatabaseSync(d1File);
      try {
        expect(schemaVersionRowSchema.parse(upgraded.prepare(
          "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
        ).get()).version).toBe(13);
        const columns = z.array(tableColumnRowSchema)
          .parse(upgraded.prepare("PRAGMA table_info(login_attempts)").all())
          .map(({name}) => name);
        expect(columns).toContain("nonce");
        const preserved = loginAttemptRowSchema.parse(upgraded.prepare(`
          SELECT code_verifier AS codeVerifier, nonce FROM login_attempts
          WHERE state_digest = 'version-three-state-digest'
        `).get());
        expect(preserved.codeVerifier).toBe("version-three-verifier");
        expect(preserved.nonce).toBeNull();
      } finally {
        upgraded.close();
      }
    } finally {
      await upgradeWorker.stop();
      await rm(upgradeDirectory, {force: true, recursive: true});
    }
  }, 120_000);
});

function bearerHeaders() {
  return {Authorization: `Bearer ${apiToken}`};
}

function jsonHeaders() {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}

/** A member and the API key bound to them, both seeded straight into D1. */
interface MemberKey {
  readonly email: string;
  readonly keyId: string;
  readonly memberId: string;
  readonly name: string;
  readonly token: string;
}

function memberKey(name: string): MemberKey {
  const keyId = `key_${createHash("sha256").update(`key:${name}`).digest("hex").slice(0, 32)}`;
  return {
    email: `${name}@example.test`,
    keyId,
    memberId: `member_${name}`,
    name,
    token: `as_key_${keyId}_${createHash("sha256").update(`secret:${name}`).digest("base64url")}`,
  };
}

function mutationHeaders(idempotencyKey: string) {
  return {...jsonHeaders(), "Idempotency-Key": idempotencyKey};
}

function authenticatedFetch(target: Unstable_DevWorker, url: string) {
  return target.fetch(url, {headers: bearerHeaders()});
}

function patchThread(
  target: Unstable_DevWorker,
  url: string,
  changes: {readonly body?: string; readonly state?: "open" | "resolved"},
) {
  return target.fetch(url, {
    body: JSON.stringify(changes),
    headers: jsonHeaders(),
    method: "PATCH",
  });
}

async function readThread(
  target: Unstable_DevWorker,
  threadsUrl: string,
  threadId: string,
) {
  const response = await authenticatedFetch(target, `${threadsUrl}/${threadId}`);
  expect(response.status).toBe(200);
  return threadDetailsSchema.parse(await response.json());
}

async function findD1DatabaseFile(directory: string): Promise<string> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const found = entries
    .filter((entry) =>
      entry.isFile() && entry.name.endsWith(".sqlite") &&
      entry.parentPath.includes("D1")
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .find((candidate) => {
      const database = new DatabaseSync(candidate, {readOnly: true});
      try {
        return database.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'artifact_server_schema'
        `).get() !== undefined;
      } finally {
        database.close();
      }
    });
  if (found === undefined) {
    throw new Error("The Worker did not persist a local D1 database file.");
  }
  return found;
}

async function publishArtifact(
  target: Unstable_DevWorker,
  idempotencyKey: string,
) {
  const bytes = new TextEncoder().encode("<h1>Comment target</h1>");
  const createUpload = await target.fetch(`${origin}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: jsonHeaders(),
    method: "POST",
  });
  expect(createUpload.status).toBe(201);
  const uploadPlan = uploadPlanSchema.parse(await createUpload.json());
  const plannedFile = uploadPlan.files[0];
  if (plannedFile === undefined) throw new Error("The upload plan is empty.");
  const uploaded = await target.fetch(plannedFile.uploadUrl, {
    body: bytes,
    headers: bearerHeaders(),
    method: "PUT",
  });
  expect(uploaded.status).toBe(200);
  const committed = await target.fetch(uploadPlan.commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Comment target",
      tags: [],
    }}),
    headers: mutationHeaders(idempotencyKey),
    method: "POST",
  });
  const committedText = await committed.text();
  if (committed.status !== 201) {
    throw new Error(
      `Publishing the comment target failed with ${committed.status}: ${committedText}`,
    );
  }
  return publicationSchema.parse(JSON.parse(committedText));
}

function startWorker(persistenceDirectory: string): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-comment-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-comment-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}
