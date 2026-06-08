import { describe, it, expect } from "vitest";
import { hasEntitlement, validateUserType } from "../src/auth-guard.js";
import type { AuthUser, SessionClaims } from "../src/types.js";

const makeUser = (userType: AuthUser["userType"]): AuthUser => ({
  id: "u1",
  email: "test@example.com",
  name: "Test User",
  userType,
  orgId: null,
  roles: [],
  createdAt: "2026-01-01T00:00:00Z",
});

describe("validateUserType", () => {
  it("returns true when userType matches expected", () => {
    expect(validateUserType(makeUser("producer"), "producer")).toBe(true);
    expect(validateUserType(makeUser("importer"), "importer")).toBe(true);
    expect(validateUserType(makeUser("admin"), "admin")).toBe(true);
  });

  it("returns false when userType does not match", () => {
    expect(validateUserType(makeUser("producer"), "importer")).toBe(false);
    expect(validateUserType(makeUser("importer"), "producer")).toBe(false);
    expect(validateUserType(makeUser("admin"), "producer")).toBe(false);
  });
});

describe("hasEntitlement", () => {
  it("returns true when the entitlement is present (AuthUser)", () => {
    const user: AuthUser = { ...makeUser("producer"), entitlements: ["producer-dashboard", "elabel"] };
    expect(hasEntitlement(user, "producer-dashboard")).toBe(true);
    expect(hasEntitlement(user, "elabel")).toBe(true);
  });

  it("returns false when the entitlement is absent or the field is missing", () => {
    // makeUser() has no `entitlements` field (older /auth/me shape).
    expect(hasEntitlement(makeUser("producer"), "producer-dashboard")).toBe(false);
    const user: AuthUser = { ...makeUser("producer"), entitlements: ["elabel"] };
    expect(hasEntitlement(user, "producer-dashboard")).toBe(false);
  });

  it("is null-safe", () => {
    expect(hasEntitlement(null, "producer-dashboard")).toBe(false);
    expect(hasEntitlement(undefined, "producer-dashboard")).toBe(false);
  });

  it("works on SessionClaims (store-decoded)", () => {
    const claims: SessionClaims = {
      userId: "u1",
      email: "test@example.com",
      orgId: null,
      roles: [],
      sessionId: "s1",
      userType: "producer",
      entitlements: ["producer-dashboard"],
    };
    expect(hasEntitlement(claims, "producer-dashboard")).toBe(true);
    expect(hasEntitlement(claims, "importer-dashboard")).toBe(false);
  });
});
