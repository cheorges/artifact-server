/**
 * The Activity tab names the person a sharing row added or removed (AUTH-039)
 * and keeps the short labels of every other kind.
 */

import {describe, expect, test} from "vitest";

import {actionLabel} from "../../apps/web/src/review/activity-label.js";

describe("activity labels (AUTH-039)", () => {
  test("AUTH-039 foundation: a sharing row names the address it added or removed", () => {
    expect(actionLabel({action: "grant_add", grantee: "anna@example.test", granteeName: null}))
      .toBe("Shared with anna@example.test");
    expect(actionLabel({action: "grant_remove", grantee: "anna@example.test", granteeName: null}))
      .toBe("Stopped sharing with anna@example.test");
  });

  test("AUTH-040 foundation: a group sharing row names the group it added or removed", () => {
    expect(actionLabel({action: "grant_group_add", grantee: "g-dep", granteeName: "Developer Productivity"}))
      .toBe("Shared with group Developer Productivity");
    expect(actionLabel({action: "grant_group_remove", grantee: "g-dep", granteeName: "Developer Productivity"}))
      .toBe("Stopped sharing with group Developer Productivity");
    expect(actionLabel({action: "grant_group_add", grantee: "g-dep", granteeName: null})).toBe("Shared with group a group");
  });

  test("AUTH-039 foundation: other rows keep their labels", () => {
    expect(actionLabel({action: "change_access", grantee: null, granteeName: null})).toBe("Changed access");
    expect(actionLabel({action: "publish", grantee: null, granteeName: null})).toBe("Published version");
  });
});
