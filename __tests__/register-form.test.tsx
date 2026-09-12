// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegisterForm } from "../src/react/register-form.js";
import { AuthError } from "../src/types.js";
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

afterEach(cleanup);

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

  it("preserves its semantic card pair after successful submit", async () => {
    // Given: valid registration details and a successful auth response.
    const { container, findByRole, getByLabelText, getByRole } = render(
      <RegisterForm
        userType="producer"
        authApi={authApi}
        onRegistered={noop}
        onNavigateLogin={noop}
      />,
    );

    // When: registration succeeds and the confirmation state renders.
    fireEvent.change(getByLabelText("Full name"), {
      target: { value: "Producer" },
    });
    fireEvent.change(getByLabelText("Email"), {
      target: { value: "producer@example.com" },
    });
    fireEvent.click(getByRole("button", { name: "Create account" }));
    const successHeading = await findByRole("heading", {
      name: "Check your email",
    });

    // Then: the rendered success card owns its matching semantic color pair.
    const successCard = container.firstElementChild;
    expect(successHeading.textContent).toBe("Check your email");
    expect(Array.from(successCard?.classList ?? [])).toEqual(
      expect.arrayContaining(["bg-card", "text-card-foreground"]),
    );
  });
});

describe("RegisterForm invite token (CEL-1814)", () => {
  it("sends the inviteToken prop with the register call", async () => {
    const register = vi.fn(async () => ({ userId: "user-invite-1" }));
    const api = { ...authApi, register } satisfies AuthApi;

    const { findByRole, getByLabelText, getByRole } = render(
      <RegisterForm
        userType="producer"
        authApi={api}
        inviteToken="11111111-1114-4111-8111-111111111141"
        onRegistered={noop}
        onNavigateLogin={noop}
      />,
    );

    fireEvent.change(getByLabelText("Full name"), { target: { value: "Invited" } });
    fireEvent.change(getByLabelText("Email"), { target: { value: "invited@winery.test" } });
    fireEvent.click(getByRole("button", { name: "Create account" }));
    await findByRole("heading", { name: "Check your email" });

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteToken: "11111111-1114-4111-8111-111111111141",
      }),
    );
  });

  it("surfaces a friendly message for REGISTRATION_CLOSED", async () => {
    const register = vi.fn(async () => {
      throw new AuthError(403, "REGISTRATION_CLOSED", "Registration is invite-only for this account type");
    });
    const api = { ...authApi, register } satisfies AuthApi;

    const { findByText, getByLabelText, getByRole } = render(
      <RegisterForm
        userType="producer"
        authApi={api}
        onRegistered={noop}
        onNavigateLogin={noop}
      />,
    );

    fireEvent.change(getByLabelText("Full name"), { target: { value: "Uninvited" } });
    fireEvent.change(getByLabelText("Email"), { target: { value: "uninvited@winery.test" } });
    fireEvent.click(getByRole("button", { name: "Create account" }));

    expect(await findByText(/invite-only/i)).toBeTruthy();
  });

  it("surfaces a friendly message for INVITE_TOKEN_INVALID", async () => {
    const register = vi.fn(async () => {
      throw new AuthError(400, "INVITE_TOKEN_INVALID", "Invitation is invalid");
    });
    const api = { ...authApi, register } satisfies AuthApi;

    const { findByText, getByLabelText, getByRole } = render(
      <RegisterForm
        userType="producer"
        authApi={api}
        inviteToken="stale-token"
        onRegistered={noop}
        onNavigateLogin={noop}
      />,
    );

    fireEvent.change(getByLabelText("Full name"), { target: { value: "Invited" } });
    fireEvent.change(getByLabelText("Email"), { target: { value: "invited@winery.test" } });
    fireEvent.click(getByRole("button", { name: "Create account" }));

    expect(await findByText(/invalid, expired/i)).toBeTruthy();
  });
});
