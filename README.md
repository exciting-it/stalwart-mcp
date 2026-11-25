# stalwart-mcp

A remote MCP server for [Stalwart](https://stalw.art) mailboxes, running on Cloudflare Workers.

A mailbox user adds the connector's address in an AI tool (Claude and others), signs in with the
mailbox login on the mail server's own page, and the tool can then list folders, search, read
conversations, write drafts and send mail in that one mailbox. The worker sits between the AI
tool and Stalwart's JMAP API: it is an OAuth server toward the tool and an OAuth client toward
Stalwart. The tool never receives a Stalwart token.

You deploy one copy per Stalwart server, in your own Cloudflare account. This is an independent
project and not affiliated with Stalwart Labs.

> **Status: not yet verified against a live server.** Every test runs against an in-memory
> stand-in for Stalwart (`test/fake-stalwart.ts`). The list under
> [Live checks](#live-checks-before-real-users) is what still has to be confirmed on a real
> server. Do not connect real users before you have worked through it.

Why it is built this way, and what its security rests on: [docs/design.md](docs/design.md).

## What an AI tool can do

| Tool | What it does |
|---|---|
| `list_mailboxes` | Folders with role and message counts, and the address of the connected mailbox |
| `search_mail` | Search by text, sender, recipient, subject, date, folder, unread, attachment |
| `read_thread` | A whole conversation as plain text |
| `create_draft` | Save a new mail or a reply in Drafts |
| `send_mail` | Send a new mail or a reply, plain text, from the mailbox's own address |
| `move_mail` | Move messages into another folder of the mailbox |
| `delete_mail` | Move messages to the Trash folder |

It cannot remove mail for good, flag mail, manage folders, touch filters, or send from another
address. Deleting always means moving to Trash, and `move_mail` brings a message back. The
connector never empties the Trash; whether the mail server does is its own setting (see Known
limits).

## Sign-in flow

1. The AI tool registers itself and sends the user's browser to `/authorize` on this worker.
2. The worker sends the browser on to Stalwart's sign-in page (PKCE, bound to the browser by a cookie).
3. The user signs in at Stalwart and confirms its consent screen.
4. Stalwart returns to `/callback`. The worker exchanges the code, reads the mailbox identity
   from Stalwart (never from the tool), stores the Stalwart tokens encrypted in that mailbox's
   vault, and shows its own page: "Connect mailbox `<address>` to `<tool>`?"
5. On Allow the worker gives the AI tool its own access and refresh token. On Deny the tool gets nothing.

## Limits

Constants live in `MAIL_LIMITS` in `src/mail.ts`.

| What | Value |
|---|---|
| Tool calls per mailbox | 60 per minute |
| Messages sent per mailbox | 50 per day |
| Recipients per message (To, Cc, Bcc together) | 10 |
| Messages per `move_mail` or `delete_mail` call | 50 |
| Identical send is not repeated within | 10 minutes (600 s) |
| Parallel calls to Stalwart per mailbox | 2 |
| Search results per page | at most 25 (default 10) |
| Messages returned per thread | at most 25 |
| Body text returned per message | 20,000 characters, then cut with a marker |
| Body text accepted when writing | 100,000 characters |
| Worker access token lifetime | 1 hour |
| Worker refresh token | ends after 30 days without use |
| Unused Stalwart connection | wiped after 30 days without a tool call |
| Abandoned or denied sign-in | cleaned up within 10 minutes |
| Connection whose AI tool never redeemed its code | cleaned up within 24 hours |
| Application removed at Stalwart | noticed at the next tool call (the tool's grant then ends), otherwise after 30 idle days |
| Audit rows are kept | 90 days |

## Deploying your own

You need a Stalwart server with its OAuth server and JMAP reachable over public HTTPS, admin
access to it, a Cloudflare account, and [Bun](https://bun.sh).

1. **Addresses.** In `wrangler.jsonc` change `routes` and the `vars` block, at the top level
   (production) and in `env.staging`:
   - `STALWART_ORIGIN`: your Stalwart server as an https origin, written the plain way:
     lower case, no path, no `:443` (`https://mail.example.com`).
   - `PUBLIC_ORIGIN`: the address the connector is served under in production, written the
     same way. It must match `routes`; production answers under no other host.
   - `CONNECTOR_NAME`: the name AI tools show (optional, default "Stalwart Mail").
2. **OAuth client on Stalwart**, one per environment: confidential, grant types authorization
   code and refresh, scope mail, exactly one redirect URI `<origin of the worker>/callback`.
3. **Storage for staging.** Create the KV namespace and the D1 database once and put their ids
   into `env.staging` in `wrangler.jsonc` (they are not secrets):
   `bunx wrangler kv namespace create stalwart-mcp-staging-oauth` and
   `bunx wrangler d1 create stalwart-mcp-staging`. If the data has to stay in a region, add
   `--jurisdiction eu` to both now; it cannot be added later (see "Where the data lives").
   Then apply the migration: `bun run migrate:staging`.
4. **Connect the repository** (Cloudflare dashboard, Workers & Pages, import a repository):
   worker name `stalwart-mcp-staging`, deploy command `bun run deploy:staging`. From then on
   every push to the connected branch deploys; nothing is uploaded by hand. The staging and the
   production worker each get their own connection to the same repository.
5. **Secrets**, per environment (`bunx wrangler secret put <NAME> --env staging`):
   - `STALWART_OAUTH_CLIENT_SECRET`: the client secret from step 2.
   - `TOKEN_ENC_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). Changing it later
     makes every stored mailbox token unreadable: every mailbox is disconnected.
6. **Dashboard variables**, per environment (kept across deploys by `keep_vars`):
   - `STALWART_OAUTH_CLIENT_ID`: the client id from step 2.
   - `SIGNIN_ALLOWLIST`: comma-separated mailbox addresses that may connect (staging).
   - `SEND_ALLOWLIST`: comma-separated addresses `send_mail` may deliver to (staging).
   - `MAIL_MCP_ENABLED`: set to `true` last. Anything else makes every endpoint answer 503.
7. Check that the Durable Object migration `v1` was applied (the `MailboxVault` class exists
   with SQLite storage), then work through the live checks below with a test mailbox.
8. Production: the same steps for the top-level environment (`stalwart-mcp`,
   `bun run migrate:production`, deploy command `bun run deploy:production`,
   `--env=""` for secrets), with its own OAuth client, secrets and variables. The allow-lists
   are not used in production.

Outside production both allow-lists are enforced in code. If a list is empty, nobody can
connect and nothing is sent. This is what makes it safe to point staging at your one, real
mail server.

### Branding

The pages a user sees in the browser (the approval page and its error pages) take their look
from `src/oauth/theme.ts` and the files in `public/brand/`: wordmark, colours, two fonts, an
icon and the artwork on the right half of wide screens. Both carry exciting IT's branding as
shipped; change the values and replace the files for your own deployment. The fonts are under
the SIL Open Font License (texts next to the files). The pages run no script and load nothing
from another origin, which their Content-Security-Policy enforces.

The sign-in page itself is Stalwart's own and is not part of this worker.

### Where the data lives

Three stores hold data, and each is pinned to a region in its own way. Decide before the first
sign-in; none of them can be changed afterwards without losing what is stored.

| Store | Holds | How to restrict it |
|---|---|---|
| Mailbox vaults (Durable Objects) | Encrypted Stalwart tokens, limits, recent sends | `DATA_JURISDICTION` in `vars`: `eu`, `us` or `fedramp` |
| D1 database | Audit log, block list, pending approvals | `--jurisdiction` when the database is created |
| KV namespace | The AI tools' grants and registrations | `--jurisdiction` when the namespace is created; Cloudflare may still cache entries elsewhere |

Vault ids depend on `DATA_JURISDICTION`, so changing it later orphans every stored connection:
users have to sign in again, and when an orphaned vault expires (30 idle days) it also ends
that mailbox's current grants. A value Cloudflare does not offer
closes the worker (503, `config_error DATA_JURISDICTION`) instead of running unrestricted.

The local runtime does not implement jurisdictions: `wrangler dev` and the tests only work
without `DATA_JURISDICTION`. The tests cover that the vault is looked up through the restricted
namespace; that it really stays there is one of the live checks.

## Live checks before real users

These need the OAuth client and a test mailbox on your server:

- [ ] With `DATA_JURISDICTION` set: sign-in and a tool call work on the deployed worker (the local runtime cannot run this).
- [ ] One grant per account and client; how a second authorization affects the first refresh token.
- [ ] Whether a rejected Bearer token counts toward Stalwart's address ban.
- [ ] The JMAP session under the `mail` scope includes submission, and `EmailSubmission/set` with the identity from `Identity/get` delivers.
- [ ] Stalwart's sign-in page accepts TOTP and passkeys in this flow.
- [ ] End to end with an AI tool's custom connector: registration, sign-in, token refresh.
- [ ] Stalwart returns a refresh token for the mail scope alone. Its documentation says it always does. If not, add `offline_access` to `STALWART.scope` in `src/stalwart/endpoints.ts`.
- [ ] The callback carries `iss=<STALWART_ORIGIN>` (the worker refuses a callback without it).
- [ ] A removed application answers the refresh with `error: "invalid_grant"`. With a bare 401 instead, the connection is only cleared by the 30-day idle alarm.
- [ ] `expires_in` in the token response is a number.
- [ ] Bcc recipients are not visible to the To and Cc recipients of a sent message.
- [ ] `move_mail` and `delete_mail` against the real server: a moved message is in the target folder only; a foreign or malformed id is reported as not found.
- [ ] Whether the server empties Trash on its own (Stalwart's auto-expunge), and whether that is what you want now that an AI tool can move mail there.
- [ ] Whether Stalwart ever reuses an account id (a reused id would meet the old vault).
- [ ] Remove the application and reconnect with two AI tools: do the earlier tools regain access (see "Known limits")?
- [ ] How long an issued Stalwart access token keeps working after the application is removed, and after the OAuth client is deleted.

Repeat them after a Stalwart upgrade.

## Runbook

**Switch everything off.** Set `MAIL_MCP_ENABLED` to anything but `true` in the dashboard. Every
endpoint answers 503: no request is served and no tool call reaches Stalwart. Only the static
brand files under `/brand/` stay reachable; they hold no data. The vaults'
cleanup alarms and the daily purge still run.

**Block one mailbox.** In the D1 database (`stalwart-mcp`, or `stalwart-mcp-staging`):

```sql
INSERT INTO blocked_accounts (key, reason, created_at)
VALUES ('<account id or lower-case address>', '<short reason>', <unix seconds>);
```

`key` is the Stalwart account id or the address **in lower case**. To find the account id of an
address, look in the audit log:
`SELECT DISTINCT account_id FROM audit_log WHERE lower(email) = lower('<address>');`
A blocked mailbox cannot sign in and every tool call is refused.

**Unblock.** `DELETE FROM blocked_accounts WHERE key = '<the same key>';`

**End all access at once.** Use the off switch. Deleting the OAuth client on Stalwart does
**not** clear connections or worker grants: a deleted client answers `invalid_client`, which the
worker deliberately does not treat as a dead mailbox grant (otherwise one wrong secret would
wipe every mailbox). Tool calls then fail with a temporary error until the client exists again.

**A user disconnects.** Any one of: remove the connector in the AI tool; remove the application
under Connected Applications in their Stalwart account; change the mailbox password.

**Where to look when something fails.** Table `audit_log` in D1. Columns: `at` (unix seconds),
`event`, `account_id`, `email`, `client_id`, `client_name`, `tool`, `outcome` (`ok`, `refused`,
`error`), `error_code`, `result_count`, `recipient_count`, `message_id`. Events: `sign_in`,
`sign_in_refused`, `approval_allowed`, `approval_denied`, `tool_call`, `upstream_revoked`,
`connection_wiped`. The log never holds subjects, bodies, search terms or recipient addresses.
The worker's `console` output holds only fixed markers such as `oauth_error <code>` and
`config_error <setting>`. Invocation logs are switched off in `wrangler.jsonc`, because they
record request URLs, and `/callback?code=…&state=…` and `/approve?h=…` carry codes and handles.

**Everything answers 503 although the switch is on.** Look for `config_error` in the worker's
logs: `STALWART_ORIGIN` or `PUBLIC_ORIGIN` is missing or not an https origin, or
`DATA_JURISDICTION` is not one of Cloudflare's. In production a
request under a host other than `PUBLIC_ORIGIN` answers 404.

## Known limits

- Stalwart's `mail` scope also covers IMAP, SMTP submission and ManageSieve and cannot be
  narrowed to JMAP. Anyone who took over this worker and its secrets could act as every
  connected mailbox. Mitigations: two secrets per environment, the off switch, and deleting the
  OAuth client.
- A send whose outcome is unknown (a timeout, a network failure or a 5xx on the submit request)
  answers `send_unconfirmed` ("Check the Sent folder before sending this message again."). It
  counts toward the daily limit, and an identical message cannot be sent again for 10 minutes;
  a different message can. The vault never retries it on its own.
- A connection the user removed at Stalwart is noticed at its next tool call, which also ends
  that tool's grant; the daily alarm checks only worker grants and idle time and never asks
  Stalwart.
- After a user removes the application at Stalwart and later connects one AI tool again, the
  earlier tools' grants for the same mailbox work again, without appearing on the approval page.
- `delete_mail` moves messages to Trash and the connector never empties it. Whether Trash is
  emptied after some time is your server's setting (Stalwart's auto-expunge), not the
  connector's: with it switched on, a deleted message does disappear later.
- The tool-call limit counts per clock minute, not a sliding minute: up to 120 calls can land
  within a few seconds around a minute boundary.
- `/token` and `/register` are limited per source address. AI vendors call them from shared
  addresses, so many users of one vendor share that limit.
- Stalwart sees every connected mailbox from Cloudflare's shared egress addresses. If Stalwart
  bans such an address, the connector stops for everyone until the ban ends.

## Development

```
bun install
bun run test        # all tests, in the Workers runtime (real KV, D1 and Durable Objects)
bun run typecheck
bun run lint
bun run depgraph    # no circular imports
bun run check:brand # every file the browser pages reference exists in public/
```

Use `bun run test`, never `bun test` (Bun's own runner ignores the Vitest setup). Nothing in the
tests contacts a real server: `fetch` is replaced by the stand-in in `test/fake-stalwart.ts`.
The end-to-end isolation test is `test/isolation.e2e.test.ts`; flows are driven by the helpers
in `test/oauth-flow.ts`.

After an upgrade of `@modelcontextprotocol/sdk`, re-run `test/mcp-handler.test.ts`: the way the
advertised tool schemas are built depends on SDK internals. The SDK and
`@cloudflare/workers-oauth-provider` are security dependencies and pinned to exact versions.

## License

[MIT](LICENSE)
