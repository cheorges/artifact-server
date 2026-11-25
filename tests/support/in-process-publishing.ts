import {createHash} from "node:crypto";

import type {ApplicationRuntime} from "../../src/application/application-runtime.js";
import {StagedUploadService} from "../../src/application/staged-upload.js";
import type {Principal} from "../../src/core/identity.js";

/** Input for publishing one small HTML artifact through the application services. */
export interface InProcessPublication {
  readonly idempotencyKey: string;
  readonly name: string;
  readonly principal: Principal;
}

/**
 * Publish a one-file artifact through the real staged-upload services, for
 * tests that compose the application layer themselves instead of using HTTP.
 */
export async function publishInProcess(
  runtime: ApplicationRuntime,
  publication: InProcessPublication,
) {
  const {idempotencyKey, name, principal} = publication;
  const bytes = new TextEncoder().encode(`<!doctype html><title>${name}</title>`);
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
  if (file === undefined) throw new Error("The fixture upload has no file.");
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
      idempotencyKey,
      principal,
      projectId: null,
      target: {accessSetting: "account_required", kind: "new_artifact", name},
      uploadId: upload.id,
    })),
  );
}
