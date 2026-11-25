import type {ArtifactAction} from "../api/client.ts";

/**
 * Converts one activity row into compact action-history text. A sharing row
 * names the address it added or removed (AUTH-039).
 */
export function actionLabel(action: Pick<ArtifactAction, "action" | "grantee">): string {
  switch (action.action) {
    case "capture":
      return "Captured linked file";
    case "link":
      return "Linked source file";
    case "relink":
      return "Relinked source file";
    case "change_access":
      return "Changed access";
    case "change_tags":
      return "Replaced tags";
    case "comment_create":
      return "Opened comment";
    case "comment_delete":
      return "Deleted comment";
    case "comment_reopen":
      return "Reopened comment";
    case "comment_reply":
      return "Replied to comment";
    case "comment_resolve":
      return "Resolved comment";
    case "comment_update":
      return "Edited comment";
    case "delete":
      return "Tombstoned artifact";
    case "grant_add":
      return `Shared with ${action.grantee ?? "someone"}`;
    case "grant_remove":
      return `Stopped sharing with ${action.grantee ?? "someone"}`;
    case "publish":
      return "Published version";
    case "restore":
      return "Restored version";
  }
  return actionHandled(action.action);
}

function actionHandled(value: never): never {
  throw new Error(`Unhandled artifact action: ${String(value)}`);
}
