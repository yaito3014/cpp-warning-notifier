import { jwtVerify, createRemoteJWKSet, SignJWT, importPKCS8 } from "jose";

export interface Env {
  /** GitHub App ID (public, set as a wrangler var) */
  GITHUB_APP_ID: string;
  /** GitHub App RSA private key in PKCS#8 PEM format (set as a wrangler secret) */
  GITHUB_APP_PRIVATE_KEY: string;
}

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "cpp-warning-notifier-worker/1.0";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "cpp-warning-notifier",
        description:
          "Issues GitHub App installation tokens to authorized GitHub Actions runs. " +
          "POST /token with a GitHub Actions OIDC JWT (audience = this worker URL) " +
          "to receive an installation access token.",
        endpoints: {
          "POST /token": "Exchange a GitHub Actions OIDC JWT for an installation access token",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/token") {
      return handleTokenRequest(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleTokenRequest(request: Request, env: Env): Promise<Response> {
  // ── 1. Extract OIDC token ──────────────────────────────────────────────────
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonError(
      "Missing or invalid Authorization header. Expected: Bearer <github-oidc-token>",
      401,
    );
  }
  const oidcToken = authHeader.slice("Bearer ".length);

  // ── 2. Verify GitHub OIDC token ───────────────────────────────────────────
  // The expected audience is the URL of this worker itself.
  // The GitHub Action must request its OIDC token with this URL as the audience.
  const workerOrigin = new URL(request.url).origin;

  let repository: string;
  try {
    const payload = await verifyGitHubOIDCToken(oidcToken, workerOrigin);
    repository = payload["repository"] as string;

    if (typeof repository !== "string" || !repository.includes("/")) {
      return jsonError("OIDC token missing or invalid 'repository' claim", 401);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(`OIDC token verification failed: ${msg}`, 401);
  }

  const slashIdx = repository.indexOf("/");
  const owner = repository.slice(0, slashIdx);
  const repo = repository.slice(slashIdx + 1);

  // ── 3. Create GitHub App JWT ───────────────────────────────────────────────
  let appJwt: string;
  try {
    appJwt = await createAppJwt(env.GITHUB_APP_PRIVATE_KEY, env.GITHUB_APP_ID);
  } catch (err) {
    console.error("Failed to create App JWT:", err);
    return jsonError("Internal error: failed to create App JWT", 500);
  }

  // ── 4. Look up the App installation for this repository ───────────────────
  let installationId: number;
  try {
    installationId = await getInstallationId(appJwt, owner, repo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) {
      return jsonError(
        `The GitHub App is not installed on ${repository}. ` +
          "Install it from the GitHub App settings page first.",
        403,
      );
    }
    console.error("Failed to get installation:", err);
    return jsonError("Failed to look up GitHub App installation", 500);
  }

  // ── 5. Create an installation access token ────────────────────────────────
  let tokenData: { token: string; expires_at: string };
  try {
    tokenData = await createInstallationToken(appJwt, installationId);
  } catch (err) {
    console.error("Failed to create installation token:", err);
    return jsonError("Failed to create installation access token", 500);
  }

  return Response.json({
    token: tokenData.token,
    expires_at: tokenData.expires_at,
    repository,
    installation_id: installationId,
  });
}

// ── GitHub OIDC helpers ────────────────────────────────────────────────────────

/**
 * Verify a GitHub Actions OIDC JWT.
 * - Fetches GitHub's public JWKS to verify the RSA signature.
 * - Checks the issuer and audience claims.
 * - jose automatically verifies expiry (exp) and not-before (nbf).
 */
async function verifyGitHubOIDCToken(
  token: string,
  expectedAudience: string,
): Promise<Record<string, unknown>> {
  const JWKS = createRemoteJWKSet(
    new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`),
  );

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: GITHUB_OIDC_ISSUER,
    audience: expectedAudience,
  });

  return payload as Record<string, unknown>;
}

// ── GitHub App JWT helpers ─────────────────────────────────────────────────────

/**
 * Create a short-lived GitHub App JWT for authenticating App-level API calls.
 * Valid for 10 minutes (GitHub's maximum is 10 minutes).
 */
async function createAppJwt(privateKeyPem: string, appId: string): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, "RS256");
  const nowSec = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(nowSec - 60) // 60 s leeway for clock skew
    .setExpirationTime(nowSec + 600) // 10 minutes
    .setIssuer(appId)
    .sign(privateKey);
}

/**
 * Retrieve the GitHub App installation ID for a repository.
 * Throws with "404" in the message if the app is not installed.
 */
async function getInstallationId(
  appJwt: string,
  owner: string,
  repo: string,
): Promise<number> {
  const response = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": USER_AGENT,
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for installation lookup: ${body}`);
  }

  const data = (await response.json()) as { id: number };
  return data.id;
}

/**
 * Exchange a GitHub App JWT for an installation access token.
 */
async function createInstallationToken(
  appJwt: string,
  installationId: number,
): Promise<{ token: string; expires_at: string }> {
  const response = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": USER_AGENT,
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} when creating installation token: ${body}`,
    );
  }

  return (await response.json()) as { token: string; expires_at: string };
}

// ── Utility ────────────────────────────────────────────────────────────────────

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
