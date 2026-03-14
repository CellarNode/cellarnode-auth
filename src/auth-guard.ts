import type { AuthUser, UserType } from "./types.js";

export function validateUserType(user: AuthUser, expected: UserType): boolean {
  return user.userType === expected;
}
