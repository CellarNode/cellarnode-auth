// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
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
