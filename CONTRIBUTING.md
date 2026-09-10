# Contributing to Tracearr

Thanks for considering a contribution. This document is how we work and what we expect. It is stricter than it used to be: two people maintain Tracearr in their spare time, and most of that time had started going to submissions that were generated, undiscussed, or both. The rules below are the fix. None of them are aimed at you, and all of them are cheap to satisfy.

Throughout, "maintainer" means an account with write access to this repository.

## Talk to Us First

Every change starts on GitHub, before any code is written.

- **Bugs**: file a bug report with the issue template.
- **Everything else**: open a thread in [Discussions](https://github.com/connorgallopo/Tracearr/discussions).

"Everything else" means anything that adds or changes a route, a setting, a background job, a migration, a UI surface, a dependency, or a translation, and any refactor. If you aren't sure whether your change counts, it does. Discord is a good place to ask questions, but agreement is recorded on GitHub because that's where the label goes (next section).

An unrequested change carries design decisions nobody agreed to, and reviewing it costs more than the discussion would have. So a PR with no prior agreement is closed regardless of code quality, whether it's a feature or a one-line bug fix. "Found this on my own install, can open an issue if you want" is closed the same way. There is no size below which this stops applying; for a small fix, the issue takes two minutes to file and usually gets labelled quickly.

The one exception is documentation-only PRs (typos, README wording): open them directly. Your account still has to be vouched.

## Getting to Yes

The whole path, in order. Each step is one action from a maintainer.

1. **You post in the right place** (above). If you want to write the code yourself, say so in the same post.
2. **A maintainer labels it accepted.** `planned` means we'll do it; `help wanted` means a contributor may. Only maintainers can label, so the label is the agreement. No label, no PR. If a maintainer replies "sounds good" and no label appears, ask for one; the bots only read labels.
3. **A maintainer vouches for your account** by commenting `!vouch`. Pull requests stay open only for vouched accounts ([Vouch](https://github.com/mitchellh/vouch); the list is `.github/VOUCHED.td`). A PR from an unvouched account is closed automatically with a note linking here. That says nothing about the code, which hasn't been read. Once vouched, reopen it. Vouching happens once per account and does not replace step 2: every PR still needs an accepted issue or discussion behind it.
4. **You open the PR** with the template filled in and the accepted issue or discussion linked. CodeRabbit runs the policy checks; a maintainer reviews the code once they pass.

Want to help but don't have a specific bug or feature in mind? Open a [Vouch request](https://github.com/connorgallopo/Tracearr/discussions/categories/vouch-requests) in your own words and we'll point you at something.

Expect replies in days, not hours. If a week passes with nothing, one ping on the thread is welcome.

## Project Structure

Tracearr is a monorepo using pnpm workspaces and Turborepo:

```
apps/
  e2e/          # Playwright end-to-end suite
  server/       # Fastify + Drizzle ORM + BullMQ + Socket.io
  web/          # React 19 + Vite + Tailwind + shadcn/ui
packages/
  emails/       # React Email templates the server renders
  shared/       # Types, Zod schemas, constants
  test-utils/   # Test factories and mocks
  translations/ # i18n
```

## Development Setup

```bash
# Start databases and Mailpit (TimescaleDB + Redis + an SMTP inbox at http://localhost:8025)
pnpm docker:up

# Install dependencies
pnpm install

# Start web and server
pnpm dev
```

## Pull Requests

Every PR:

- Links the issue or discussion labelled `planned` or `help wanted`.
- Stays inside the scope agreed there. A PR that grows past it is sent back to be split.
- Passes CI. Locally that is `pnpm lint && pnpm typecheck && pnpm test`; CI also runs the integration tier, the web tests, and the e2e suite.
- Fills in the PR template as-is. Replacing it with your tool's default output counts as not filling it in.
- Includes screenshots for UI changes.
- Comes with tests. New behavior needs tests; a bug fix needs a regression test unless the PR says why one isn't practical.
- Leaves translations alone. Non-English locale files are managed in Crowdin by volunteer translators. Edit only `packages/translations/src/locales/en/` and Crowdin does the rest (see `packages/translations/README.md`). PRs that hand-edit other locales are sent back.

### Commit Messages

Write commit messages in plain language. Describe what changed.

Good:

- `Add session termination endpoint`
- `Fix trust score calculation for users with no sessions`

Bad:

- `feat(sessions): implement termination functionality`
- `fix: resolve issue with calculation`

We don't use conventional commit prefixes.

## On AI-Assisted Code

We're fine with AI tools. Copilot, Claude, Cursor, whatever helps you work. The following are rules, not preferences.

**You wrote it.** AI can help with parts you name, and you must be able to explain and change every line. If during review you can't answer questions about your own diff, the PR is closed. A PR whose implementation the tool wrote and whose author's part was to review and test the output ("Claude wrote the code and tests, I checked it line by line and tested it live") is closed, disclosed or not, however good it looks. So is one from someone who says they don't know the language the project is written in. Owning the diagnosis or the manual testing doesn't change that.

**Disclose significant AI usage in the PR template.** Not every autocomplete, but if AI wrote a substantial part, tick the box and say which parts. "Used AI" is not enough; "wrote the Emby adapter myself, used Claude for the Zod schema and to chase down a socket race" is. The box tells us where to look harder. It is not permission for anything in the previous paragraph.

**Reply in your own words.** Review questions answered by pasting AI output end the review. If English isn't your first language and you translated your reply, say so; that's fine.

**Don't commit your local tooling.** `.claude/`, `CLAUDE.md`, `.cursor/`, `AGENTS.md`, editor settings. Run `git status` before you push.

We're not banning AI. A 5,000-line PR with no tests and an author who can't explain it is the thing we're preventing.

## Autonomous Agents and Generated Submissions

We don't accept contributions from autonomous agents. Pull requests and issues we believe were created autonomously are closed, and automated comments may be marked as spam. Bypassing or replacing the issue and PR templates counts.

The human-shaped version gets the same treatment: someone pointed an AI at something they wanted, opened whatever came out, and can't explain the diff. That gets closed too. Bug reports as well: fill in the template with what happened and attach logs. A report that swaps the template for an AI-written diagnosis and a suggested fix is closed, because generated analysis is not evidence.

**Escalation** is the same for all of the above. The first time, the submission is closed with a link to this document. The second time, a maintainer comments `!denounce`, and from then on that account's issues and PRs are closed the moment they open. Separately, maintainers may close any issue, discussion, or PR at their discretion, without explanation.

## Testing

```bash
pnpm test:unit        # Unit tests (fast, run these often)
pnpm test             # Every mocked tier: unit, services, routes, auth, security
pnpm test:integration # Real TimescaleDB and Redis (pnpm docker:up first)
pnpm test:e2e         # Playwright; starts server and web itself, needs docker/docker-compose.test.yml up
```

New behavior needs tests. A bug fix needs a regression test unless the PR says why one isn't practical.

## Code Style

- React Query for server state
- PascalCase for components (`UserProfile.tsx`), camelCase for utils (`sessionService.ts`)

Linting is oxlint (type-aware, one pass over every workspace) and formatting is Prettier. Run `pnpm lint` and `pnpm format` before committing.

## Questions

Open a GitHub Discussion or ask on [Discord](https://discord.gg/a7n3sFd2Yw).
