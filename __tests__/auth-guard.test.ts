import { describe, it, expect } from "vitest";
import { validateUserType } from "../src/auth-guard.js";
import type { AuthUser } from "../src/types.js";

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
