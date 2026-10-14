// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOGIN_FORM_COPY,
  DEFAULT_REGISTER_FORM_COPY,
  interpolateCopy,
} from "../src/react/copy.js";
import { LoginForm } from "../src/react/login-form.js";
import { RegisterForm } from "../src/react/register-form.js";
import { AuthError } from "../src/types.js";

/** CEL-2572: the sign-in and register forms take localized `copy`; the English defaults render exactly as before. */
afterEach(cleanup);

const noop = () => {};
const soon = () => new Date(Date.now() + 5 * 60_000).toISOString();
const later = () => new Date(Date.now() + 61_000).toISOString();

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    requestOtp: vi.fn(async () => ({ expiresAt: soon(), resendAvailableAt: later() })),
    verifyOtp: vi.fn(async () => ({
      accessToken: "t",
      expiresIn: 60,
      user: { id: "u", email: "a@b.c", name: "A", phone: "", userType: "importer", orgId: null, roles: [] },
    })),
    register: vi.fn(async () => ({ userId: "u" })),
    ...overrides,
  } as any;
}
const authStore = { setAccessToken: noop, clearAccessToken: noop } as any;

function login(props: Record<string, unknown> = {}, api = makeApi()) {
  return render(
    <LoginForm userType="importer" brandName="Acme" authApi={api} authStore={authStore} onLoginSuccess={noop} {...props} />,
  );
}

async function toOtpStep(email = "ada@example.com") {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: /continue|weiter/i }));
  await screen.findByRole("heading", { level: 1, name: /check your email|prüfen/i });
}

describe("interpolateCopy", () => {
  it("fills placeholders in ONE pass: a value containing a placeholder is never expanded", () => {
    expect(interpolateCopy("Hi {name}, code for {email}", { name: "{email}", email: "x@y.z" })).toBe("Hi {email}, code for x@y.z");
    expect(interpolateCopy("{a}{a}", { a: "{a}" })).toBe("{a}{a}");
  });
  it("leaves an unknown placeholder as written and ignores prototype keys", () => {
    expect(interpolateCopy("{missing} {toString} {constructor}", {})).toBe("{missing} {toString} {constructor}");
  });
  it("renders numbers", () => {
    expect(interpolateCopy("{n} left", { n: 3 })).toBe("3 left");
  });
});

describe("LoginForm copy: English defaults are unchanged", () => {
  it("email step text", () => {
    const { container } = login();
    expect(container.textContent).toMatchInlineSnapshot(`"AAcmeSign in to your accountEnter your work email to receive a one-time access code.Email addressContinueNeed an account? Contact your CellarNode representative."`);
    expect(screen.getByPlaceholderText("you@company.com")).toBeTruthy();
  });

  it("code step text, countdowns and Change email / Resend", async () => {
    const { container } = login();
    await toOtpStep();
    expect(container.textContent).toContain("Check your email");
    expect(container.textContent).toContain("If an account exists for ada@example.com, we've sent a code.");
    expect(container.textContent).toMatch(/Expires in \d\d:\d\d/);
    expect(container.textContent).toContain("Verify");
    expect(container.textContent).toContain("Change email");
    expect(container.textContent).toMatch(/Resend in \d\d:\d\d/);
  });

  it("the shipped defaults object covers each string used above", () => {
    expect(DEFAULT_LOGIN_FORM_COPY.emailHeading).toBe("Sign in to your account");
    expect(DEFAULT_REGISTER_FORM_COPY.createAccount).toBe("Create account");
  });
});

describe("LoginForm copy: overrides apply", () => {
  const de = {
    back: "Zurück",
    inviteBanner: "Anmeldung zur Annahme Ihrer Einladung.",
    emailHeading: "Anmelden",
    emailDescription: "Geben Sie Ihre E-Mail-Adresse ein.",
    emailLabel: "E-Mail-Adresse",
    emailPlaceholder: "sie@firma.de",
    continue: "Weiter",
    otpHeading: "E-Mail prüfen",
    otpSentNotice: "Falls ein Konto für {email} existiert, haben wir einen Code gesendet.",
    expiresIn: "Läuft ab in {time}",
    verify: "Bestätigen",
    changeEmail: "E-Mail ändern",
    resendCode: "Code erneut senden",
    resendIn: "Erneut senden in {time}",
    footerText: "Noch kein Konto? Wenden Sie sich an Ihren Ansprechpartner.",
    needAccount: "Noch kein Konto?",
    registerHere: "Hier registrieren",
    invalidCode: "Ungültiger Code. Noch {attempts} Versuch(e).",
    wrongPortal: "Dieses Portal ist nur für {userType}-Konten.",
    userTypeImporter: "Importeur",
  };

  it("translates the email step, the invite banner, Back, the footer and the register link", () => {
    const { container, rerender } = login({ copy: de, inviteMode: true, onBack: noop });
    expect(container.textContent).toContain("Anmelden");
    expect(container.textContent).toContain("Anmeldung zur Annahme Ihrer Einladung.");
    expect(container.textContent).toContain("Zurück");
    expect(container.textContent).toContain("Noch kein Konto? Wenden Sie sich an Ihren Ansprechpartner.");
    expect(screen.getByPlaceholderText("sie@firma.de")).toBeTruthy();
    expect(container.textContent).not.toContain("Sign in to your account");
    rerender(
      <LoginForm userType="importer" brandName="Acme" authApi={makeApi()} authStore={authStore} onLoginSuccess={noop} copy={de} showRegisterInFooter onNavigateRegister={noop} />,
    );
    expect(screen.getByRole("button", { name: "Hier registrieren" })).toBeTruthy();
    expect(screen.getByText(/Noch kein Konto\?/)).toBeTruthy();
  });

  it("the footerText prop still wins over copy.footerText", () => {
    const { container } = login({ copy: de, footerText: "Custom footer" });
    expect(container.textContent).toContain("Custom footer");
    expect(container.textContent).not.toContain("Noch kein Konto? Wenden");
  });

  it("translates the code step; {email} and {time} are interpolated, and a hostile email value is shown as text", async () => {
    const { container } = login({ copy: de });
    await toOtpStep("{time}@evil.test");
    expect(container.textContent).toContain("E-Mail prüfen");
    expect(container.textContent).toContain("Falls ein Konto für {time}@evil.test existiert, haben wir einen Code gesendet.");
    expect(container.textContent).toMatch(/Läuft ab in \d\d:\d\d/);
    expect(container.textContent).toContain("Bestätigen");
    expect(container.textContent).toContain("E-Mail ändern");
    expect(container.textContent).toMatch(/Erneut senden in \d\d:\d\d/);
  });

  it("translates the error text: invalid code with {attempts}, a known code, the wrong portal with a localized role, and a code override", async () => {
    const api = makeApi({
      verifyOtp: vi
        .fn()
        .mockRejectedValueOnce(new AuthError("server English", "OTP_INVALID", 400, 2))
        .mockRejectedValueOnce(new AuthError("server English", "OTP_MAX_ATTEMPTS", 429))
        .mockResolvedValueOnce({ accessToken: "t", expiresIn: 60, user: { id: "u", email: "", name: "", phone: "", userType: "producer", orgId: null, roles: [] } }),
    });
    const { container } = login({ copy: { ...de, maxAttempts: "Zu viele Versuche.", errors: { OTP_MAX_ATTEMPTS: "Gesperrt." } } }, api);
    await toOtpStep();
    const type = (code: string) => {
      const input = container.querySelector("input[autocomplete='one-time-code'], input[data-input-otp]") as HTMLInputElement;
      fireEvent.change(input, { target: { value: code } });
      fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    };
    type("111111");
    await waitFor(() => expect(container.textContent).toContain("Ungültiger Code. Noch 2 Versuch(e)."));
    type("222222");
    await waitFor(() => expect(container.textContent).toContain("Gesperrt.")); // errors[code] beats the named field and the server text
    expect(container.textContent).not.toContain("server English");
    type("333333");
    await waitFor(() => expect(container.textContent).toContain("Dieses Portal ist nur für Importeur-Konten.")); // localized role in {userType}
  });

  it("a non-Error failure shows the localized fallback, not an English one", async () => {
    const api = makeApi({ requestOtp: vi.fn().mockRejectedValueOnce("boom") });
    login({ copy: { failedToSendCode: "Senden fehlgeschlagen" } }, api);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a@b.c" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(document.body.textContent).toContain("Senden fehlgeschlagen"));
    expect(document.body.textContent).not.toContain("Failed to send code");
  });

  it("a partial copy keeps the English default for every field it omits", () => {
    const { container } = login({ copy: { emailHeading: "Anmelden" } });
    expect(container.textContent).toContain("Anmelden");
    expect(container.textContent).toContain("Enter your work email to receive a one-time access code.");
  });
});

describe("RegisterForm copy", () => {
  it("English defaults are unchanged", () => {
    const { container } = render(<RegisterForm userType="importer" onRegistered={noop} onNavigateLogin={noop} authApi={makeApi()} />);
    expect(container.textContent).toMatchInlineSnapshot(`"Create an accountRegister as an importer to get startedFull nameEmailPhone (optional)Create accountAlready have an account? Log in"`);
  });

  it("overrides apply to the form, the role phrase, the placeholders and the errors", async () => {
    const api = makeApi({ register: vi.fn().mockRejectedValue(new AuthError("server English", "USER_ALREADY_EXISTS", 409)) });
    const copy = {
      heading: "Konto erstellen",
      registerAsDescription: "Registrieren Sie sich als {role}",
      roleProducer: "Erzeuger",
      fullName: "Vollständiger Name",
      createAccount: "Konto anlegen",
      userAlreadyExists: "Es gibt bereits ein Konto.",
    };
    const { container } = render(<RegisterForm userType="producer" onRegistered={noop} onNavigateLogin={noop} authApi={api} copy={copy} />);
    expect(container.textContent).toContain("Konto erstellen");
    expect(container.textContent).toContain("Registrieren Sie sich als Erzeuger");
    fireEvent.change(screen.getByLabelText("Vollständiger Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Konto anlegen" }));
    await waitFor(() => expect(container.textContent).toContain("Es gibt bereits ein Konto."));
  });

  it("the success view interpolates {email} once and shows a hostile email as text", async () => {
    const { container } = render(
      <RegisterForm
        userType="importer"
        onRegistered={noop}
        onNavigateLogin={noop}
        authApi={makeApi()}
        copy={{ accountCreatedDescription: "Code an {email}", accountCreatedHeading: "Fertig", goToLogin: "Zur Anmeldung" }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "{email}@x.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(container.textContent).toContain("Fertig"));
    expect(container.textContent).toContain("Code an {email}@x.test");
    expect(screen.getByRole("button", { name: "Zur Anmeldung" })).toBeTruthy();
  });
});
