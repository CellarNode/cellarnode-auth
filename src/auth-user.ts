import type {
  AuthUser,
  SessionUserType,
  VerifyOtpUser,
} from "./types.js";

const SESSION_USER_TYPES = new Set<SessionUserType>([
  "importer",
  "producer",
  "distributor",
  "admin",
]);

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseRequiredUserFields(value: unknown): VerifyOtpUser | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== "string" ||
    user.id.length === 0 ||
    typeof user.email !== "string" ||
    typeof user.name !== "string" ||
    !hasOwn(user, "orgId") ||
    !(user.orgId === null || typeof user.orgId === "string") ||
    !hasOwn(user, "userType") ||
    !(
      user.userType === null ||
      (typeof user.userType === "string" &&
        SESSION_USER_TYPES.has(user.userType as SessionUserType))
    ) ||
    !Array.isArray(user.roles) ||
    !user.roles.every((role) => typeof role === "string") ||
    (user.phone !== undefined && typeof user.phone !== "string")
  ) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    ...(user.phone === undefined ? {} : { phone: user.phone }),
    userType: user.userType as SessionUserType | null,
    orgId: user.orgId as string | null,
    roles: [...user.roles] as string[],
  };
}

/** Validate and defensively copy the sparse `/auth/verify-otp` user. */
export function parseVerifyOtpUser(value: unknown): VerifyOtpUser | null {
  return parseRequiredUserFields(value);
}

/** Validate and defensively copy the complete `/auth/me` response. */
export function parseAuthUser(value: unknown): AuthUser | null {
  const required = parseRequiredUserFields(value);
  if (!required) return null;

  const user = value as Record<string, unknown>;
  if (
    typeof user.createdAt !== "string" ||
    (user.entitlements !== undefined &&
      (!Array.isArray(user.entitlements) ||
        !user.entitlements.every(
          (entitlement) => typeof entitlement === "string",
        )))
  ) {
    return null;
  }

  return {
    ...required,
    ...(user.entitlements === undefined
      ? {}
      : { entitlements: [...user.entitlements] as string[] }),
    createdAt: user.createdAt,
  };
}

export function copyAuthUser(user: AuthUser): AuthUser {
  return {
    ...user,
    roles: [...user.roles],
    ...(user.entitlements === undefined
      ? {}
      : { entitlements: [...user.entitlements] }),
  };
}
