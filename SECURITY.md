# Security Policy

> [!CAUTION]
> Unedited LLM "audit" reports waste my time and will be closed without a detailed response. Repeat offenders get blocked. See [AI / LLM-generated reports](#ai--llm-generated-reports) below for what's acceptable.

Tracearr is a self-hosted, single-owner monitoring tool. It assumes you run it on your own infrastructure, behind your own network, with one admin account that you control. The threat model is "the authenticated owner is fully trusted; everyone else is denied at the auth layer." Reports that assume otherwise are out of scope.

## Supported Versions

The latest tagged release and current `main` receive security fixes. Older releases do not. If you're on an old version, upgrade first; if the bug is still present, then report it.

## Reporting a Vulnerability

Use **GitHub's "Report a vulnerability" button** under the Security tab of this repo. That opens a private channel that goes straight to me and integrates with GitHub Security Advisories and CVE issuance.

If GitHub PVR is unavailable, email security@tracearr.com with `[Tracearr Security]` in the subject.

**Do not open a public issue for a suspected vulnerability.**

## What to include

For a report to be actionable:

- Tracearr version (commit SHA if you're on `main`)
- A working proof-of-concept against a stock deployment
- The HTTP requests and responses, or the exact code path you exercised
- What you observed, what you expected, and the real-world impact

If your PoC requires DB access, the JWT signing secret, code execution on the host, or any other already-game-over precondition, it isn't a vulnerability. See scope below.

## Response

I'm a solo developer working on this in my spare time. Best-effort targets:

- Acknowledge within 5 business days
- Confirm or reject within 14 days
- Ship a fix within 90 days of confirmation, sooner if impact warrants it

If you don't hear back, ping me in the Discord (link in README).

## Disclosure

Coordinated disclosure. Once a fix ships, I publish a GitHub Security Advisory (with credit, if you want it) at least 14 days after release so users have time to update. Don't publish details before that.

If 90 days pass without a fix and you want to publish, that's fair. Let me know first so I can prep users.

## In scope

- Auth bypass that doesn't require pre-existing credentials or host access
- Token exposure or credential leakage to unauthorized parties
- Stored XSS or HTML injection that lands in the owner's browser
- RCE on the Tracearr host via a crafted upstream (Plex/Jellyfin/Emby/tofa/Silo) response
- SQL injection
- SSRF that reaches internal targets without owner auth
- Information disclosure on unauthenticated endpoints
- Anything that breaks the "owner-only access" model from outside

## Out of scope

These are not vulnerabilities and reports will be closed:

- **Anything requiring DB or filesystem access on the host.** If you can write to the DB you've already won; no auth model survives that.
- **Anything requiring `JWT_SECRET`.** Same reasoning. With the secret you can mint owner tokens directly.
- **Anything requiring a non-owner login.** Tracearr has no multi-user login. Only the owner can authenticate. The `viewer`/`admin` role values in the schema are unused scaffolding for future work. Reports assuming non-owner accounts can be created are not actionable.
- **Owner-authenticated routes where the owner is the only "victim".** The owner is trusted by design. CSRF, missing rate limits, IDOR, etc. on owner-only endpoints are not vulnerabilities unless they cross a trust boundary.
- **Plaintext token storage in the local DB.** Intentional. The DB is localhost-only, and tokens are needed in plaintext to make outbound calls to media servers.
- **Upstream vulnerabilities** in Plex, Jellyfin, Emby, tofa, Silo, or third-party dependencies. Report those upstream. I'll bump versions when fixes ship.
- **Missing security headers** (CSP, HSTS, etc.) without a demonstrated exploit. PRs welcome, but it isn't a security finding on its own.
- **Self-XSS, clickjacking, tabnabbing** on owner-only routes.
- **DoS via misconfiguration** (polling intervals, no rate limit on local API, etc.).
- **Theoretical findings without a PoC.** "This pattern _could_ be exploitable if X were true" doesn't count unless X is reachable.

## AI / LLM-generated reports

Reports drafted with AI help are fine. Pasting AI output without verification isn't.

If you used an LLM to find or write up the issue:

- **Run the PoC yourself against a real Tracearr deployment.** Static analysis hallucinates exploits constantly. Running the code is the only way to confirm.
- **Disclose the AI assistance** in the report. Something like _"This was drafted with Claude Code"_ or _"I used GPT to map the codebase but verified the exploit manually"_ is enough.
- **Sanity-check the assumptions.** LLMs reading this codebase consistently invent things that don't exist in the product: non-owner logins, multi-tenant scenarios, user invite endpoints, role promotion APIs. If your reproduction steps start with something the product can't actually do, the report will be closed.

Unedited LLM audit output will be closed without a detailed response. Repeat offenders get blocked. This isn't personal; triaging that kind of report eats hours I'd rather spend fixing real bugs.

## Safe Harbor

Good-faith security research is welcome. I will not pursue civil or criminal action, or report you to law enforcement, for activity that:

- Stays on your own deployment
- Doesn't degrade service for other users
- Doesn't access, modify, or exfiltrate data you don't own
- Gives me reasonable time to fix before public disclosure

If you're not sure whether something crosses a line, ask first.

## Bounties

There are none. I can't pay them and don't want the dynamics they create. I will credit you in the security advisory and the changelog. If you want to be listed publicly with a link, say so in the report.
