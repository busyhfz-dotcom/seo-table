import { describePolicy, permissionMatrix } from "@seo/core";
import { handler } from "../../../../lib/route";

/** The live safety policy and permission matrix, so the UI renders facts. */
export const GET = handler({ permission: "project:read" }, async () => ({
  policy: describePolicy(),
  roles: permissionMatrix(),
}));
