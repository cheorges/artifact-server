/** The in-memory directory the group grant tests share (AUTH-040, AUTH-041). */

import {expect, test} from "vitest";

import {createFakeGroupDirectory} from "./fake-group-directory.js";

test("the fake directory searches by word start and by exact address, and fails on demand", async () => {
  const directory = createFakeGroupDirectory();
  directory.addGroup({id: "g-dep", displayName: "Developer Productivity", mail: "dep@example.test"}, ["oid-ada"]);
  expect((await directory.searchGroups("prod")).map((group) => group.id)).toEqual(["g-dep"]);
  expect(await directory.searchGroups("ductiv")).toEqual([]);
  expect((await directory.searchGroups("dep@example.test")).map((group) => group.id)).toEqual(["g-dep"]);
  expect(await directory.groupIdsOfSubject("oid-ada")).toEqual(["g-dep"]);
  expect(await directory.groupIdsOfSubject("oid-ben")).toEqual([]);
  directory.failNext(1);
  await expect(directory.findGroup("g-dep")).rejects.toMatchObject({_tag: "DirectoryUnavailable"});
  expect((await directory.findGroup("g-dep"))?.displayName).toBe("Developer Productivity");
});
