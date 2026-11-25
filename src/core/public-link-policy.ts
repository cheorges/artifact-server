import {Effect} from "effect";

import {AuthorizationDenied} from "./errors.js";
import {accessSettings, type AccessSetting} from "./model.js";

/** Whether an installation lets artifacts be read without signing in. */
export const publicLinkPolicies = {
  off: "off",
  on: "on",
} as const;

export type PublicLinkPolicy =
  (typeof publicLinkPolicies)[keyof typeof publicLinkPolicies];

/**
 * Report whether an artifact with this access setting is readable without
 * signing in. With public links off, a `public_link` artifact stays stored as
 * it is but is served only to signed-in members, like `account_required`.
 */
export function isPubliclyReadable(
  accessSetting: AccessSetting,
  policy: PublicLinkPolicy,
): boolean {
  return policy === publicLinkPolicies.on &&
    accessSetting === accessSettings.publicLink;
}

/** Refuse a new public link when the installation has turned them off. */
export function requireAccessSettingAllowed(
  accessSetting: AccessSetting,
  policy: PublicLinkPolicy,
): Effect.Effect<void, AuthorizationDenied> {
  return accessSetting === accessSettings.publicLink &&
      policy === publicLinkPolicies.off
    ? Effect.fail(new AuthorizationDenied({
      message: "This installation does not allow public links.",
    }))
    : Effect.void;
}
