import {createHash} from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {
  createStagedUpload,
  publishNew,
  type TestSiteFile,
  uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const refusal = "This installation does not allow public links.";
const errorSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const sessionSchema = z.object({
  capabilities: z.object({publicLinks: z.boolean()}).loose(),
});
const artifactSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link", "restricted"]),
  currentVersionId: z.string(),
  id: z.string(),
});
const artifactEnvelopeSchema = z.object({artifact: artifactSchema});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({artifact: artifactSchema})),
});
const publicLinkPageSchema = z.object({
  publicLinks: z.array(z.object({artifact: artifactSchema})),
});
const toolCallResultSchema = z.object({
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
});
const capabilitiesResultSchema = z.object({
  sharing: z.object({modes: z.array(z.string())}),
});
const createUploadResultSchema = z.object({
  files: z.array(z.object({method: z.literal("PUT"), path: z.string(), uploadUrl: z.url()})),
  uploadGrant: z.object({token: z.string()}),
  uploadId: z.string(),
});
const committedSchema = z.object({
  artifact: artifactSchema,
  version: z.object({id: z.string()}),
});

describe("installation public-link policy", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-006-B: with public links off, new public links are refused over HTTP and links made earlier stop being publicly readable but stay recoverable", async () => {
    server = await startTestServer(installation);
    const earlier = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Public before the switch</title>",
      idempotencyKey: "auth-006-public-before-001",
      name: "Public before the switch",
    });
    expect(earlier.response.status).toBe(201);
    const openWhileOn = await fetchVersion(server, earlier.body.links.version);
    expect(openWhileOn.status).toBe(200);
    expect(openWhileOn.headers.get("cache-control")).toContain("public");

    await server.stop();
    server = await startTestServer(installation, {publicLinks: "off"});

    const session = sessionSchema.parse(await (await authenticatedFetch(
      "/api/v1/session",
    )).json());
    expect(session.capabilities.publicLinks).toBe(false);

    const anonymousVersion = await fetchVersion(server, earlier.body.links.version);
    expect(anonymousVersion.status).toBe(401);
    expect(anonymousVersion.headers.get("cache-control")).toBe("private, no-store");
    // The restarted server listens on a new port; the artifact path stays the same.
    const artifactPath = new URL(earlier.body.links.artifact).pathname;
    expect((await fetch(`${server.baseUrl}${artifactPath}`, {redirect: "manual"})).status)
      .toBe(401);

    const refused = await commitNewArtifact("public_link", "auth-006-http-public-001");
    expect(refused.status).toBe(403);
    expect(errorSchema.parse(await refused.json()).error).toEqual({
      code: "AUTHORIZATION_DENIED",
      message: refusal,
    });
    const afterRefusal = artifactPageSchema.parse(await (await authenticatedFetch(
      "/api/v1/artifacts",
    )).json());
    expect(afterRefusal.artifacts.map(({artifact}) => artifact.id))
      .toEqual([earlier.body.artifact.id]);

    const accepted = await commitNewArtifact(
      "account_required",
      "auth-006-http-account-001",
    );
    expect(accepted.status).toBe(201);
    const published = artifactEnvelopeSchema.parse(await accepted.json()).artifact;
    const change = await changeAccess(published, "public_link", "auth-006-http-change-001");
    expect(change.status).toBe(403);
    expect(errorSchema.parse(await change.json()).error.message).toBe(refusal);
    expect((await readArtifact(published.id)).accessSetting).toBe("account_required");

    // Only a signed-in administrator reads the cross-project inventory.
    const administrator = await signInAdministrator(server, installation);
    const inventory = publicLinkPageSchema.parse(await (await fetch(
      `${server.baseUrl}/api/v1/administration/public-links`,
      {headers: {Cookie: administrator.header}},
    )).json());
    expect(inventory.publicLinks.map((item) => item.artifact.id))
      .toEqual([earlier.body.artifact.id]);
    const madePrivate = await changeAccess(
      earlier.body.artifact,
      "account_required",
      "auth-006-make-private-001",
    );
    expect(madePrivate.status).toBe(200);
    expect((await readArtifact(earlier.body.artifact.id)).accessSetting)
      .toBe("account_required");
  });

  test("AUTH-006-F: an agent cannot publish or switch to a public link through MCP when the installation turns public links off", async () => {
    server = await startTestServer(installation, {publicLinks: "off"});

    const capabilities = capabilitiesResultSchema.parse(
      (await callTool("artifact_capabilities", {})).structuredContent,
    );
    expect(capabilities.sharing.modes).not.toContain("public_link");
    expect(capabilities.sharing.modes).toContain("account_required");

    const refusedCommit = await commitMcpUpload("public_link", "auth-006-mcp-public-001");
    expect(refusedCommit.isError).toBe(true);
    expect(refusedCommit.content[0]?.text).toContain("AUTHORIZATION_DENIED");
    expect(refusedCommit.content[0]?.text).toContain(refusal);

    const committed = committedSchema.parse(
      (await commitMcpUpload("account_required", "auth-006-mcp-account-001"))
        .structuredContent,
    );
    const refusedChange = await callTool("artifact_set_visibility", {
      accessSetting: "public_link",
      artifactId: committed.artifact.id,
      expectedCurrentVersionId: committed.version.id,
      idempotencyKey: "auth-006-mcp-change-001",
    });
    expect(refusedChange.isError).toBe(true);
    expect(refusedChange.content[0]?.text).toContain(refusal);
    expect((await readArtifact(committed.artifact.id)).accessSetting)
      .toBe("account_required");
  });

  function authenticatedFetch(route: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${installation.apiToken}`);
    return fetch(`${server.baseUrl}${route}`, {...init, headers});
  }

  function changeAccess(
    artifact: {readonly currentVersionId: string; readonly id: string},
    accessSetting: "account_required" | "public_link",
    idempotencyKey: string,
  ): Promise<Response> {
    return authenticatedFetch(`/api/v1/artifacts/${artifact.id}/access`, {
      body: JSON.stringify({
        accessSetting,
        expectedCurrentVersionId: artifact.currentVersionId,
      }),
      headers: apiHeaders(installation, idempotencyKey),
      method: "PATCH",
    });
  }

  async function readArtifact(artifactId: string) {
    const response = await authenticatedFetch(`/api/v1/artifacts/${artifactId}`);
    expect(response.status).toBe(200);
    return artifactEnvelopeSchema.parse(await response.json()).artifact;
  }

  async function commitNewArtifact(
    accessSetting: "account_required" | "public_link",
    idempotencyKey: string,
  ): Promise<Response> {
    const file = htmlFile(`<!doctype html><title>${idempotencyKey}</title>`);
    const upload = await createStagedUpload(server, installation, file.path, [file]);
    for (const uploaded of await uploadEveryStagedFile(installation, upload.body, [file])) {
      expect(uploaded.status).toBe(200);
    }
    return fetch(upload.body.commitUrl, {
      body: JSON.stringify({
        target: {accessSetting, kind: "new_artifact", name: idempotencyKey},
      }),
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    });
  }

  async function commitMcpUpload(
    accessSetting: "account_required" | "public_link",
    idempotencyKey: string,
  ) {
    const file = htmlFile(`<!doctype html><title>${idempotencyKey}</title>`);
    const created = await callTool("artifact_create_upload", {
      entryPath: file.path,
      files: [{
        mediaType: file.mediaType,
        path: file.path,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        size: file.bytes.byteLength,
      }],
    });
    const upload = createUploadResultSchema.parse(created.structuredContent);
    const uploaded = await Promise.all(upload.files.map((plan) =>
      fetch(plan.uploadUrl, {
        body: Buffer.from(file.bytes),
        headers: {Authorization: `Bearer ${upload.uploadGrant.token}`},
        method: plan.method,
      })
    ));
    expect(uploaded.map((response) => response.status)).toEqual([200]);
    return callTool("artifact_commit_upload", {
      idempotencyKey,
      target: {accessSetting, kind: "new_artifact", name: idempotencyKey},
      uploadId: upload.uploadId,
    });
  }

  async function callTool(name: string, toolArguments: McpParameters) {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
          arguments: toolArguments,
          name,
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    return toolCallResultSchema.parse(await response.json()).result;
  }
});

interface McpParameters {
  readonly [key: string]: McpParameterValue;
}

type McpParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpParameterValue[]
  | McpParameters;

function htmlFile(content: string): TestSiteFile {
  return {
    bytes: new TextEncoder().encode(content),
    mediaType: "text/html",
    path: "index.html",
  };
}
