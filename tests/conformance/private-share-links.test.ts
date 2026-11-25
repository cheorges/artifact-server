import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {OidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  issueLocalBrowserLogin,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  startStubOidcLogin,
  startStubOidcProvider,
  type RunningStubOidcProvider,
} from "../support/stub-oidc-provider.js";

/** The headers a browser sends when a person opens a link from outside the site. */
const externalNavigation = {
  Accept: "text/html,application/xhtml+xml",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
} as const;

describe("private Latest and Raw links", () => {
  let applicationOrigin: string;
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    const port = await reserveLoopbackPort();
    applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {applicationOrigin, port});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-033-B: a signed-in member opens the Latest link and the Raw link of a private artifact", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>First private page</title>",
      idempotencyKey: "private-share-links-first",
      name: "Private share links",
      path: "docs/page.html",
    });
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><title>Second private page</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "private-share-links-second",
      path: "docs/page.html",
    });
    const session = await signInLocally(server, installation);

    const latest = await fetchVersion(server, first.body.links.artifact, "GET", {
      ...externalNavigation,
      Cookie: session,
    });
    expect(latest.status).toBe(302);
    expect(latest.headers.get("cache-control")).toBe("private, no-store");
    expect(latest.headers.get("referrer-policy")).toBe("no-referrer");
    const latestBootstrap = new URL(requiredHeader(latest.headers, "location"));
    expect(latestBootstrap.origin).toBe(new URL(second.body.links.version).origin);
    expect(latestBootstrap.pathname).toBe("/");
    expect(latestBootstrap.searchParams.has("__artifact_bootstrap")).toBe(true);
    const latestPage = await openThroughBootstrap(server, latestBootstrap);
    expect(await latestPage.text()).toContain("Second private page");

    const rawUrl = new URL("/docs/page.html", first.body.links.version);
    const raw = await fetchVersion(server, rawUrl.toString(), "GET", externalNavigation);
    expect(raw.status).toBe(302);
    expect(raw.headers.get("cache-control")).toBe("private, no-store");
    const signIn = new URL(requiredHeader(raw.headers, "location"));
    expect(signIn.origin).toBe(applicationOrigin);
    expect(signIn.pathname).toBe(`/content-sessions/${rawUrl.hostname.split(".")[0]}`);
    expect(signIn.searchParams.get("path")).toBe("docs/page.html");

    const issued = await fetchVersion(server, signIn.toString(), "GET", {
      ...externalNavigation,
      "Sec-Fetch-Site": "cross-site",
      Cookie: session,
    });
    expect(issued.status).toBe(302);
    expect(issued.headers.get("cache-control")).toBe("private, no-store");
    const rawBootstrap = new URL(requiredHeader(issued.headers, "location"));
    expect(rawBootstrap.origin).toBe(rawUrl.origin);
    expect(rawBootstrap.pathname).toBe("/docs/page.html");
    const rawPage = await openThroughBootstrap(server, rawBootstrap);
    expect(await rawPage.text()).toContain("First private page");

    const root = await fetchVersion(server, first.body.links.version, "GET", externalNavigation);
    expect(new URL(requiredHeader(root.headers, "location")).searchParams.has("path"))
      .toBe(false);
  });

  test("AUTH-033-F: private links open nothing without application sign-in and cannot loop or be steered", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Closed page</title>",
      idempotencyKey: "private-share-links-closed",
      name: "Closed share links",
    });
    const artifactPath = `/artifacts/${published.body.artifact.id}`;
    const contentToken = new URL(published.body.links.version).hostname.split(".")[0];
    const startPath = `/content-sessions/${contentToken}`;

    const anonymousLatest = await fetchVersion(
      server,
      published.body.links.artifact,
      "GET",
      externalNavigation,
    );
    expect(anonymousLatest.status).toBe(302);
    expect(anonymousLatest.headers.get("cache-control")).toBe("private, no-store");
    const latestLogin = new URL(
      requiredHeader(anonymousLatest.headers, "location"),
      applicationOrigin,
    );
    expect(latestLogin.pathname).toBe("/auth/login");
    expect(latestLogin.searchParams.get("returnTo")).toBe(artifactPath);
    expect((await fetch(published.body.links.artifact, {redirect: "manual"})).status)
      .toBe(401);

    const anonymousStart = await fetchVersion(
      server,
      `${applicationOrigin}${startPath}?path=index.html`,
      "GET",
      externalNavigation,
    );
    expect(anonymousStart.status).toBe(302);
    const startLogin = new URL(
      requiredHeader(anonymousStart.headers, "location"),
      applicationOrigin,
    );
    expect(startLogin.pathname).toBe("/auth/login");
    expect(startLogin.searchParams.get("returnTo")).toBe(`${startPath}?path=index.html`);
    expect((await fetch(`${applicationOrigin}${startPath}`, {redirect: "manual"})).status)
      .toBe(401);

    // Scripts, embedded frames, writes, and the bootstrap page's own refresh
    // never leave the content host: only a person opening the link does.
    const closed = await Promise.all([
      fetchVersion(server, published.body.links.version),
      fetchVersion(server, published.body.links.version, "GET", {
        ...externalNavigation,
        "Sec-Fetch-Site": "same-origin",
      }),
      fetchVersion(server, published.body.links.version, "GET", {
        ...externalNavigation,
        "Sec-Fetch-Dest": "iframe",
      }),
      fetchVersion(server, published.body.links.version, "GET", {
        ...externalNavigation,
        "Sec-Fetch-Mode": "no-cors",
      }),
      fetchVersion(server, published.body.links.version, "HEAD", externalNavigation),
    ]);
    expect(closed.map(({status}) => status)).toEqual([401, 401, 401, 401, 401]);

    const steered = await fetchVersion(server, published.body.links.version, "GET", {
      ...externalNavigation,
      "X-Forwarded-Host": "hostile.example",
      "X-Forwarded-Proto": "https",
    });
    expect(steered.status).toBe(302);
    expect(new URL(requiredHeader(steered.headers, "location")).origin)
      .toBe(applicationOrigin);

    const session = await signInLocally(server, installation);
    const unknown = await fetchVersion(
      server,
      `${applicationOrigin}/content-sessions/${"u".repeat(32)}`,
      "GET",
      {...externalNavigation, Cookie: session},
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("location")).toBeNull();

    // An installation without a configured application origin has nowhere
    // trusted to send a person, so its content hosts keep answering 401.
    await server.stop();
    server = await startTestServer(installation);
    expect((await fetchVersion(
      server,
      published.body.links.version,
      "GET",
      externalNavigation,
    )).status).toBe(401);
  });
});

describe("private links behind OIDC sign-in", () => {
  const administratorEmail = "administrator@example.test";
  let applicationOrigin: string;
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId: "artifact-server-share-links"});
    provider.claims.email = administratorEmail;
    const port = await reserveLoopbackPort();
    applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: new OidcIdentityProvider({
        clientId: provider.clientId,
        clientSecret: null,
        issuer: provider.issuer,
        redirectUri: `${applicationOrigin}/auth/callback`,
        scopes: "openid email profile",
      }),
      port,
    });
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-033 through OIDC: a person without a session signs in and lands on the private artifact's current version", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Signed-in page</title>",
      idempotencyKey: "private-share-links-oidc",
      name: "Signed-in share link",
    });

    const latest = await fetchVersion(
      server,
      published.body.links.artifact,
      "GET",
      externalNavigation,
    );
    expect(latest.status).toBe(302);
    const returnTo = new URL(requiredHeader(latest.headers, "location"), applicationOrigin)
      .searchParams.get("returnTo");
    expect(returnTo).toBe(`/artifacts/${published.body.artifact.id}`);

    const authorization = await startStubOidcLogin(applicationOrigin, returnTo);
    const callback = await fetch(authorization.callbackUrl, {
      headers: {Cookie: authorization.handshakeCookie},
      redirect: "manual",
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(returnTo);

    const opened = await fetchVersion(
      server,
      new URL(returnTo ?? "/", applicationOrigin).toString(),
      "GET",
      {
        ...externalNavigation,
        "Sec-Fetch-Site": "cross-site",
        Cookie: sessionCookie(callback.headers.getSetCookie()),
      },
    );
    expect(opened.status).toBe(302);
    const page = await openThroughBootstrap(
      server,
      new URL(requiredHeader(opened.headers, "location")),
    );
    expect(await page.text()).toContain("Signed-in page");
  });
});

/** Sign in through the local browser login and return the session cookie. */
async function signInLocally(
  server: RunningTestServer,
  installation: TestInstallation,
): Promise<string> {
  const token = await issueLocalBrowserLogin(server, installation);
  const login = await fetch(`${server.baseUrl}/auth/local?token=${token}`, {
    redirect: "manual",
  });
  if (login.status !== 303) {
    throw new Error(`The local browser login failed with ${login.status}.`);
  }
  return sessionCookie(login.headers.getSetCookie());
}

/** Exchange one bootstrap URL like a browser and load its destination. */
async function openThroughBootstrap(
  server: RunningTestServer,
  bootstrapUrl: URL,
): Promise<Response> {
  const exchange = await fetchVersion(server, bootstrapUrl.toString());
  expect(exchange.status).toBe(200);
  const cookie = requiredHeader(exchange.headers, "set-cookie").split(";", 1)[0];
  if (cookie === undefined) throw new Error("The content cookie is empty.");
  const page = await fetchVersion(
    server,
    new URL(bootstrapUrl.pathname, bootstrapUrl.origin).toString(),
    "GET",
    {...externalNavigation, "Sec-Fetch-Site": "same-origin", Cookie: cookie},
  );
  expect(page.status).toBe(200);
  return page;
}

function sessionCookie(setCookieHeaders: readonly string[]): string {
  const session = setCookieHeaders.find((value) =>
    value.startsWith("artifact_session=")
  )?.split(";", 1)[0];
  if (session === undefined) {
    throw new Error("The login response did not issue an application session.");
  }
  return session;
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) throw new Error(`The ${name} response header is missing.`);
  return value;
}
