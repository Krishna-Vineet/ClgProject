import { expect, test } from "bun:test";
import { suspendUser } from "../src/modules/admin/service";

test("admin suspension rejects the acting admin's own account before database access", async () => {
  await expect(
    suspendUser("admin-id", "admin-id", { reason: "should be refused" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
