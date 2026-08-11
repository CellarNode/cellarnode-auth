import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RegisterForm } from "../src/react/register-form.js";
import type { AuthApi } from "../src/types.js";
import { classTokensAt } from "./class-tokens.js";

const noop = () => {};

const authApi = {
  register: async () => ({ userId: "user-1" }),
  requestOtp: async () => ({ expiresAt: "", resendAvailableAt: "" }),
  verifyOtp: async () => ({
    accessToken: "",
    expiresIn: 0,
    user: {
      id: "user-1",
      email: "producer@example.com",
      name: "Producer",
      userType: "producer",
      orgId: null,
      roles: [],
      createdAt: "2026-08-11T00:00:00Z",
    },
  }),
  logout: async () => {},
  getMe: async () => ({
    id: "user-1",
    email: "producer@example.com",
    name: "Producer",
    userType: "producer",
    orgId: null,
    roles: [],
    createdAt: "2026-08-11T00:00:00Z",
  }),
} satisfies AuthApi;

describe("RegisterForm theme surfaces", () => {
  it("pairs its semantic card surface with card foreground", () => {
    // Given: a consumer rendering the shared registration card.
    // When: the initial form is rendered.
    const html = renderToStaticMarkup(
      <RegisterForm
        userType="producer"
        authApi={authApi}
        onRegistered={noop}
        onNavigateLogin={noop}
      />,
    );

    // Then: dark and light theme tokens resolve as a coherent pair.
    expect(classTokensAt(html, 0)).toEqual(
      expect.arrayContaining(["bg-card", "text-card-foreground"]),
    );
  });
});
