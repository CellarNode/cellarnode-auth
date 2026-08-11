import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UnauthorizedPage } from "../src/react/unauthorized.js";
import { classTokensAt } from "./class-tokens.js";

// CEL-918: every rendered string must be overridable via the `labels` prop so
// consumers can localize; omitted fields keep their English defaults. Static
// markup rendering keeps this suite on the repo's node-only vitest setup.

const noop = () => {};

const dashboardLinks = [
  { userType: "importer", label: "Importer Dashboard", url: "https://importer.example" },
];

describe("UnauthorizedPage labels (CEL-918)", () => {
  it("owns semantic page and card color pairs", () => {
    // Given: the generic shared unauthorized surface.
    // When: it renders without consumer-level color classes.
    const html = renderToStaticMarkup(
      <UnauthorizedPage expectedRole="producers" onNavigateLogin={noop} />,
    );

    // Then: page and card foregrounds remain paired with their semantic surfaces.
    expect(classTokensAt(html, 0)).toEqual(
      expect.arrayContaining(["bg-background", "text-foreground"]),
    );
    expect(classTokensAt(html, 1)).toEqual(
      expect.arrayContaining(["bg-card", "text-card-foreground"]),
    );
  });

  it("owns semantic page and card color pairs on the portal-aware view", () => {
    // Given: an authenticated user viewing a dashboard for another role.
    // When: the portal-aware unauthorized state renders.
    const html = renderToStaticMarkup(
      <UnauthorizedPage
        expectedRole="producers"
        onNavigateLogin={noop}
        authenticatedUserType="importer"
        dashboardLinks={dashboardLinks}
      />,
    );

    // Then: each semantic foreground remains on its matching surface element.
    expect(classTokensAt(html, 0)).toEqual(
      expect.arrayContaining(["bg-background", "text-foreground"]),
    );
    expect(classTokensAt(html, 1)).toEqual(
      expect.arrayContaining(["bg-card", "text-card-foreground"]),
    );
  });

  it("renders English defaults on the access-denied view", () => {
    const html = renderToStaticMarkup(
      <UnauthorizedPage expectedRole="producers" onNavigateLogin={noop} />,
    );

    expect(html).toContain("Access Denied");
    expect(html).toContain("This dashboard is for producers only.");
    expect(html).toContain("Back to Login");
  });

  it("renders English defaults on the wrong-portal view", () => {
    const html = renderToStaticMarkup(
      <UnauthorizedPage
        expectedRole="producers"
        onNavigateLogin={noop}
        authenticatedUserType="importer"
        dashboardLinks={dashboardLinks}
      />,
    );

    expect(html).toContain("Wrong Portal");
    expect(html).toContain("Go to Importer Dashboard");
    expect(html).toContain("Sign in with a different account");
  });

  it("applies overrides for every access-denied string", () => {
    const html = renderToStaticMarkup(
      <UnauthorizedPage
        expectedRole="producers"
        onNavigateLogin={noop}
        labels={{
          accessDeniedTitle: "Zugriff verweigert",
          accessDeniedDescription: "Dieses Dashboard ist nur für Produzenten.",
          backToLogin: "Zurück zur Anmeldung",
        }}
      />,
    );

    expect(html).toContain("Zugriff verweigert");
    expect(html).toContain("Dieses Dashboard ist nur für Produzenten.");
    expect(html).toContain("Zurück zur Anmeldung");
    expect(html).not.toContain("Access Denied");
    expect(html).not.toContain("Back to Login");
    expect(html).not.toContain("contact support");
  });

  it("applies overrides for every wrong-portal string", () => {
    const html = renderToStaticMarkup(
      <UnauthorizedPage
        expectedRole="producers"
        onNavigateLogin={noop}
        authenticatedUserType="importer"
        dashboardLinks={dashboardLinks}
        labels={{
          wrongPortalTitle: "Falsches Portal",
          wrongPortalDescription: "Sie sind als Importeur angemeldet.",
          goToDashboard: (label) => `Weiter zu ${label}`,
          switchAccount: "Mit anderem Konto anmelden",
        }}
      />,
    );

    expect(html).toContain("Falsches Portal");
    expect(html).toContain("Sie sind als Importeur angemeldet.");
    expect(html).toContain("Weiter zu Importer Dashboard");
    expect(html).toContain("Mit anderem Konto anmelden");
    expect(html).not.toContain("Wrong Portal");
    expect(html).not.toContain("Go to Importer Dashboard");
    expect(html).not.toContain("Sign in with a different account");
  });

  it("keeps defaults for fields omitted from a partial labels object", () => {
    const html = renderToStaticMarkup(
      <UnauthorizedPage
        expectedRole="producers"
        onNavigateLogin={noop}
        labels={{ accessDeniedTitle: "Solo override" }}
      />,
    );

    expect(html).toContain("Solo override");
    expect(html).toContain("Back to Login");
  });
});
