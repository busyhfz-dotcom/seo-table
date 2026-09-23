/**
 * Role-based access control.
 *
 * The permission table is the single source of truth and is checked on the
 * server for every mutating route. The UI hides what a role cannot do, but
 * hiding is not enforcement — `assertCan` is.
 */
import { Forbidden } from "./errors.js";

export type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";

export const PERMISSIONS = [
  "project:read",
  "project:write",
  "project:delete",
  "scan:run",
  "scan:cancel",
  "issue:read",
  "issue:ignore",
  "fix:propose",
  "fix:apply_low_risk",
  "fix:approve_sensitive",
  "fix:rollback",
  "connector:read",
  "connector:write",
  "report:read",
  "report:write",
  "member:manage",
  "apikey:manage",
  "auditlog:read",
  "billing:manage",
  // Tracked keywords, competitors, and starting rank / PageSpeed / competitor runs.
  "tracking:write",
  // Organization-wide paid data sources and alert channels (credentials).
  "integration:manage",
  // Content editor documents: write, import, analyse, and ask for WordPress publishing
  // (publishing itself needs fix:approve_sensitive).
  "content:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = ["project:read", "issue:read", "connector:read", "report:read"];

const EDITOR: Permission[] = [
  ...VIEWER,
  "scan:run",
  "scan:cancel",
  "issue:ignore",
  "fix:propose",
  "fix:apply_low_risk",
  "report:write",
  "tracking:write",
  "content:write",
];

const ADMIN: Permission[] = [
  ...EDITOR,
  "project:write",
  "fix:approve_sensitive",
  "fix:rollback",
  "connector:write",
  "member:manage",
  "apikey:manage",
  "auditlog:read",
  "integration:manage",
];

const OWNER: Permission[] = [...ADMIN, "project:delete", "billing:manage"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  VIEWER,
  EDITOR,
  ADMIN,
  OWNER,
};

export function can(role: Role, permission: Permission): boolean {
  // A role string from a stale session or a future enum value grants nothing;
  // `hasOwn` also keeps "constructor" and friends from resolving on the prototype.
  if (!Object.hasOwn(ROLE_PERMISSIONS, role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new Forbidden(`Your role (${role}) cannot ${permission}`, { role, permission });
  }
}

/** Convenience for the settings UI: the full matrix, rendered as data. */
export function permissionMatrix(): Array<{ role: Role; permissions: Permission[] }> {
  return (Object.keys(ROLE_PERMISSIONS) as Role[]).map((role) => ({
    role,
    permissions: [...ROLE_PERMISSIONS[role]],
  }));
}
