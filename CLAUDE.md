# CLAUDE.md — stalwart-mcp

A remote MCP server in front of a Stalwart mail server, on Cloudflare Workers. Read
`docs/design.md` (why it is built this way, security model) and `README.md` (how it is run)
before changing anything. This is auth and mail code: boring correctness is the goal.

## Non-negotiable

1. **Identity comes from the grant, never from a request.** No tool has a parameter for the
   account or the From address. Ids supplied by an AI tool are only used inside the grant's own
   account.
2. **An AI tool never receives a Stalwart token.** Stalwart tokens exist only in the mailbox
   vault, encrypted, and must not be reachable through the vault's RPC surface (TypeScript
   `private` is still callable over RPC: use `#` members or symbol keys).
3. **Every tool goes through `defineTool`** (validate → authorize → act → audit). No tool logic
   in `src/mcp/` or `src/index.ts`.
4. **Addresses are deployment settings.** The Stalwart server and the worker's own origin come
   from `vars` in `wrangler.jsonc`, never from request input, and a bad value closes the worker.
5. **Staging safety is enforced in code:** outside production only allow-listed mailboxes
   connect and mail goes only to allow-listed recipients.
6. **Nothing from a mailbox in logs, audit rows or error messages:** no tokens, subjects,
   bodies, search terms or recipient addresses. Error messages are the fixed texts in
   `src/mail.ts`.
7. **No secrets in the repo.** Secrets via `wrangler secret`, separate per environment.
8. **`wrangler.jsonc` is the source of truth for deploy config.** `vars` holds only what is
   fixed per deployment; what an operator tunes while it runs lives in the dashboard.
9. **No invisible characters in source files.** Write them as `\u` escapes.

## Tests

- New logic gets tests in the same change, against `test/fake-stalwart.ts`.
- A change to tools or sign-in keeps the isolation test green (mailbox A cannot reach mailbox B).
- Anything that sends is tested twice in a row: exactly one message goes out.
- Tests are never deleted or skipped to get green.
- Run `bun run test` (Vitest), never `bun test`.

Before "done": `bun run lint && bun run typecheck && bun run test && bun run depgraph && bun run check:brand`, and
`bunx wrangler deploy --dry-run` for both environments.

## Working style

- Deploys go through Cloudflare Workers Builds (the Git connection runs `bun run deploy:<env>`),
  never by hand and not from GitHub Actions. Actions is the quality gate.
- Nothing against a real mail server and no deploy without the owner's OK.
- Docs, comments and commit messages in English.
