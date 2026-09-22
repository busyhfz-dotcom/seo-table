import { handler } from "../../../../lib/route";
import { userOrgs } from "../../../../lib/auth";

/** The organizations the signed-in person belongs to, for the organization switcher. */
export const GET = handler({ sessionOnly: true }, async ({ session }) => ({
  orgs: (await userOrgs(session.userId)).map((m) => ({
    orgId: m.orgId,
    name: m.name,
    role: m.role,
    current: m.orgId === session.orgId,
  })),
}));
