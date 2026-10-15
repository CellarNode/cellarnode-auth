// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOGIN_FORM_COPY, DEFAULT_REGISTER_FORM_COPY } from "../src/react/copy.js";
import { LoginForm } from "../src/react/login-form.js";
import { RegisterForm } from "../src/react/register-form.js";
import { AuthError } from "../src/types.js";

/**
 * Sentinel completeness (CEL-2572). Every copy field is replaced with a «key» marker; after removing the markers, NO Latin letter may
 * be left anywhere a user can read or hear (text nodes, aria-label, placeholder, title, alt, SVG <title>...). A string a developer
 * forgets to route through `copy` shows up here as English the markers did not replace. Every state of both forms is visited.
 */
afterEach(cleanup);

const noop = () => {};
const ATTRS = ["aria-label", "aria-description", "aria-valuetext", "aria-roledescription", "placeholder", "title", "alt"];

function visibleText(root: ParentNode = document.body): string[] {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node.textContent?.trim();
      if (text) out.push(text);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "style" || tag === "script") return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) out.push(v);
    }
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
}

function expectNoEnglish(state: string) {
  const left = visibleText()
    .map((t) => t.replace(/«[^»]*»/g, ""))
    .filter((t) => /[A-Za-z]/.test(t));
  expect(left, `bare English in state "${state}"`).toEqual([]);
}

const sentinel = (key: string) => `«${key}»`;

/** Every field of the login copy as a sentinel; placeholder fields become functions so no token has to survive. */
function loginSentinels() {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(DEFAULT_LOGIN_FORM_COPY)) {
    if (key === "errors") continue;
    copy[key] = typeof value === "string" && !/\{\w+\}/.test(value) ? sentinel(key) : () => sentinel(key);
  }
  for (const key of ["userNotFound", "productFamilyNotAllowed", "otpUserInvalid", "tokenExtractionFailed"]) copy[key] = sentinel(key);
  return copy;
}

const authStore = { setAccessToken: noop, clearAccessToken: noop } as any;
const later = () => new Date(Date.now() + 61_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();
const user = (userType: string) => ({ id: "u", email: "1@2.3", name: "N", phone: "", userType, orgId: null, roles: [] });

function makeApi(opts: { resendAt?: () => string; verify?: ReturnType<typeof vi.fn>; request?: ReturnType<typeof vi.fn> } = {}) {
  return {
    requestOtp: opts.request ?? vi.fn(async () => ({ expiresAt: later(), resendAvailableAt: (opts.resendAt ?? later)() })),
    verifyOtp: opts.verify ?? vi.fn(async () => ({ accessToken: "t", expiresIn: 60, user: user("importer") })),
    register: vi.fn(async () => ({ userId: "u" })),
  } as any;
}

function renderLogin(api: any, props: Record<string, unknown> = {}) {
  return render(
    <LoginForm userType="importer" brandName="«b»" authApi={api} authStore={authStore} onLoginSuccess={noop} copy={loginSentinels()} {...props} />,
  );
}

async function advance(api: any) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "1@2.3" } });
  fireEvent.click(screen.getByRole("button", { name: sentinel("continue") }));
  await screen.findByRole("heading", { level: 1, name: sentinel("otpHeading") });
  void api;
}

function typeCode(code: string) {
  const input = document.querySelector("input[data-input-otp]") as HTMLInputElement;
  fireEvent.change(input, { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: sentinel("verify") }));
}

describe("LoginForm: no bare English with a sentinel copy", () => {
  it("covers the email step, in each variant", () => {
    renderLogin(makeApi());
    expectNoEnglish("email step");
    cleanup();
    renderLogin(makeApi(), { inviteMode: true, onBack: noop });
    expectNoEnglish("invite mode + back");
    cleanup();
    renderLogin(makeApi(), { showRegisterInFooter: true, onNavigateRegister: noop });
    expectNoEnglish("register in footer");
  });

  it("covers the code step with the cooldown running and after it", async () => {
    const api = makeApi();
    renderLogin(api);
    await advance(api);
    expectNoEnglish("code step, cooldown running");
    cleanup();
    const ready = makeApi({ resendAt: past });
    renderLogin(ready);
    await advance(ready);
    expectNoEnglish("code step, resend available");
  });

  it("covers the error states: invalid code, each typed code, wrong portal, a non-Error and a TypeError", async () => {
    const codes = ["OTP_INVALID", "OTP_RATE_LIMIT", "OTP_NOT_FOUND", "OTP_MAX_ATTEMPTS", "USER_DELETED", "USER_NOT_FOUND", "PRODUCT_FAMILY_NOT_ALLOWED", "OTP_USER_INVALID", "TOKEN_EXTRACTION_FAILED"];
    for (const code of codes) {
      const verify = vi.fn().mockRejectedValue(new AuthError(400, code, "Raw server English", 2));
      const api = makeApi({ verify });
      renderLogin(api);
      await advance(api);
      typeCode("123456");
      await waitFor(() => expect(document.querySelector("[role='alert']")).not.toBeNull());
      expectNoEnglish(`verify rejected with ${code}`);
      cleanup();
    }
    // Wrong portal.
    {
      const api = makeApi({ verify: vi.fn(async () => ({ accessToken: "t", expiresIn: 60, user: user("producer") })) });
      renderLogin(api);
      await advance(api);
      typeCode("123456");
      await waitFor(() => expect(document.querySelector("[role='alert']")).not.toBeNull());
      expectNoEnglish("wrong portal");
      cleanup();
    }
    // Email-step rejections that carry no message of their own: a non-Error and a network TypeError.
    for (const rejection of ["boom", new TypeError("Failed to fetch")]) {
      const api = makeApi({ request: vi.fn().mockRejectedValue(rejection) });
      renderLogin(api, { copy: { ...loginSentinels(), somethingWentWrong: sentinel("sw") } });
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "1@2.3" } });
      fireEvent.click(screen.getByRole("button", { name: sentinel("continue") }));
      await act(async () => {});
      await waitFor(() => expect(document.querySelector("[role='alert']")).not.toBeNull());
      expectNoEnglish(`email step rejected with ${String(rejection)}`);
      cleanup();
    }
  });

  it("the walker would notice a bare English string (kills: a collector that finds nothing)", () => {
    renderLogin(makeApi(), { copy: { ...loginSentinels(), continue: "Continue" } });
    expect(() => expectNoEnglish("deliberately untranslated")).toThrow();
  });
});

describe("RegisterForm: no bare English with a sentinel copy", () => {
  function registerSentinels() {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(DEFAULT_REGISTER_FORM_COPY)) {
      if (key === "errors") continue;
      copy[key] = typeof value === "string" && !/\{\w+\}/.test(value) ? sentinel(key) : () => sentinel(key);
    }
    return copy;
  }

  it("covers the form, its errors and the success view", async () => {
    const copy = registerSentinels();
    render(<RegisterForm userType="importer" onRegistered={noop} onNavigateLogin={noop} authApi={makeApi()} copy={copy} />);
    expectNoEnglish("register form");
    cleanup();
    const failing = { ...makeApi(), register: vi.fn().mockRejectedValue(new AuthError(409, "USER_ALREADY_EXISTS", "Raw server English")) };
    render(<RegisterForm userType="producer" onRegistered={noop} onNavigateLogin={noop} authApi={failing} copy={copy} />);
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "N" } });
    fireEvent.change(screen.getAllByRole("textbox")[1]!, { target: { value: "1@2.3" } });
    fireEvent.click(screen.getByRole("button", { name: sentinel("createAccount") }));
    await waitFor(() => expect(document.querySelector("[role='alert']")).not.toBeNull());
    expectNoEnglish("register error");
    cleanup();
    // The other three register codes, an unknown code, a network TypeError and a non-Error.
    for (const rejection of [
      new AuthError(400, "USER_DELETED", "Raw server English"),
      new AuthError(403, "REGISTRATION_CLOSED", "Raw server English"),
      new AuthError(400, "INVITE_TOKEN_INVALID", "Raw server English"),
      new AuthError(502, "UNKNOWN", "Raw server English"),
      new TypeError("Failed to fetch"),
      "boom",
    ]) {
      const api = { ...makeApi(), register: vi.fn().mockRejectedValue(rejection) };
      render(
        <RegisterForm
          userType="producer"
          onRegistered={noop}
          onNavigateLogin={noop}
          authApi={api}
          copy={{ ...copy, networkError: sentinel("networkError") }}
        />,
      );
      fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "N" } });
      fireEvent.change(screen.getAllByRole("textbox")[1]!, { target: { value: "1@2.3" } });
      fireEvent.click(screen.getByRole("button", { name: sentinel("createAccount") }));
      await waitFor(() => expect(document.querySelector("[role='alert']")).not.toBeNull());
      expectNoEnglish(`register rejected with ${String(rejection)}`);
      cleanup();
    }
    render(<RegisterForm userType="producer" onRegistered={noop} onNavigateLogin={noop} authApi={makeApi()} copy={copy} />);
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "N" } });
    fireEvent.change(screen.getAllByRole("textbox")[1]!, { target: { value: "1@2.3" } });
    fireEvent.click(screen.getByRole("button", { name: sentinel("createAccount") }));
    await screen.findByRole("heading", { name: sentinel("accountCreatedHeading") });
    expectNoEnglish("register success");
  });
});
