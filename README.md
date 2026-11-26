# stalwart-mcp

A remote MCP server for [Stalwart](https://stalw.art) mailboxes, running on Cloudflare Workers.

A mailbox user adds the connector's address in an AI tool (Claude and others), signs in with the
mailbox login on the mail server's own page, and the tool can then list folders, search, read
conversations, write drafts and send mail in that one mailbox. Unless the deployment switches
that off, the tool can also read and write that mailbox's contacts and calendar, including events with
participants, whom the mail server then invites by email. The worker sits between the AI
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
| `search_contacts` | Search the address book by text, name, email, phone, organization or address book (needs `contacts`) |
| `read_contact` | One contact: names, emails, phones, organizations, addresses, birthday, notes (needs `contacts`) |
| `list_calendars` | The mailbox's calendars with id, name and whether they are writable (needs `calendars`) |
| `search_events` | Events that overlap a time window of at most 180 days, one entry per occurrence of a recurring event (needs `calendars`) |
| `read_event` | One event: time, locations, description, participants, meeting links, recurrence (needs `calendars`) |
| `create_contact` | Create a contact: names, up to 10 emails and 10 phones, organization, job title, notes, birthday (needs `contacts`) |
| `update_contact` | Change a contact; a given field replaces the stored one (needs `contacts`) |
| `delete_contact` | Delete up to 50 contacts **for good** (needs `contacts`) |
| `create_event` | Create an event: timed or all-day, location, description, up to 10 participants, a recurrence rule; participants get an invitation by email (needs `calendars`) |
| `update_event` | Change an event or one occurrence; participants get an update by email (needs `calendars`) |
| `delete_event` | Delete up to 50 events or occurrences **for good**; participants of the mailbox's own events get a cancellation by email (needs `calendars`) |

The contacts and calendar tools exist unless the deployment switches their area off with
`DISABLED_FEATURES`
(see [Contacts and calendars](#contacts-and-calendars)). Deleting a contact or an event is
permanent: JMAP has no trash for them. An event write that involves participants makes the mail
server send them mail (invitations, updates, cancellations), and each such write counts as one
of the mailbox's 50 sends per day (one per started ten addresses). The connector never answers
an invitation: a change or deletion of a meeting someone else organized only touches the
mailbox's own copy.

It cannot remove mail for good, flag mail, manage folders, touch filters, or send from another
address. Deleting always means moving to Trash, and `move_mail` brings a message back. The
connector never empties the Trash; whether the mail server does is its own setting (see Known
limits).

## Sign-in flow

1. The AI tool registers itself and sends the user's browser to `/authorize` on this worker.
2. The worker shows its own intro page: what is about to happen, on which server the sign-in
   takes place and which login is meant. Its one link leads to Stalwart's sign-in page (PKCE,
   bound to the browser by a cookie). The page has no form: a password is only ever typed at
   Stalwart.
3. The user signs in at Stalwart and confirms its consent screen.
4. Stalwart returns to `/callback`. The worker exchanges the code, reads the mailbox identity
   from Stalwart (never from the tool), stores the Stalwart tokens encrypted in that mailbox's
   vault, and shows its own page: "Connect mailbox `<address>` to `<tool>`?"
5. On Allow the worker gives the AI tool its own access and refresh token. On Deny the tool gets nothing.

## Limits

Constants live in `MAIL_LIMITS` in `src/mail.ts` and, for contacts and calendars,
`COLLAB_LIMITS` in `src/collab.ts`.

| What | Value |
|---|---|
| Tool calls per mailbox (mail, contacts and calendar calls together) | 60 per minute |
| Messages sent per mailbox (`send_mail` and every event write that notifies participants, together) | 50 per day |
| Recipients per message (To, Cc, Bcc together) | 10 |
| Messages per `move_mail` or `delete_mail` call | 50 |
| Identical send (or identical notifying `create_event` / `update_event`) is not repeated within | 10 minutes (600 s) |
| Parallel calls to Stalwart per mailbox | 2 |
| Search results per page | at most 25 (default 10) |
| Messages returned per thread | at most 25 |
| Contacts per `search_contacts` page | at most 25 (default 10) |
| Events per `search_events` page | at most 50 (default 25) |
| Window of `search_events` (`after` to `before`) | at most 180 days |
| `offset` of `search_contacts` and `search_events` | 0 to 10,000 |
| Ids per `delete_contact` or `delete_event` call | 50 (no daily limit on deleting; deleting is permanent) |
| Emails and phones one contact input may carry | 10 each, a phone number 50 characters |
| Participants of `create_event` / `update_event` (besides the mailbox itself) | 10 |
| Longest timed event (`start` to `end`) / all-day event (`days`) | 31 days / 366 days |
| Recurrence rule | `interval` 1 to 99, `count` 1 to 730 or `until` a date, `by_day` only for weekly |
| Text of a name, title, label, location, participant or other single line | 200 characters |
| Postal address of a contact | 500 characters |
| Contact notes | 2,000 characters, then `notes_truncated` |
| Event description | 5,000 characters, then `description_truncated` |
| Emails and phones in a contact summary | 5 each |
| Emails, phones, addresses, titles, nicknames, organizations in a contact | 20 each |
| Locations, online meeting links, participants of an event | 5, 3 (http and https only), 50 (the rest counted in `participants_omitted`) |
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

1. **Addresses.** In `wrangler.jsonc` change `routes` and the `vars` block:
   - `STALWART_ORIGIN`: your Stalwart server as an https origin, written the plain way:
     lower case, no path, no `:443` (`https://mail.example.com`).
   - `PUBLIC_ORIGIN`: the address the connector is served under, written the same way. It
     must match `routes`; the worker answers under no other host.
   - `CONNECTOR_NAME`: the name AI tools show (optional, default "Stalwart Mail").
   - `STALWART_OAUTH_CLIENT_ID`: the id of the OAuth client from step 2. It is not a secret.
   - `DATA_JURISDICTION`: optional; decide before the first sign-in (see
     [Where the data lives](#where-the-data-lives)).
2. **OAuth client on Stalwart**: confidential, grant types authorization code and refresh,
   scopes mail, contacts and calendars (without the scope of an area you switch off, see
   [Contacts and calendars](#contacts-and-calendars)), exactly one redirect URI
   `<PUBLIC_ORIGIN>/callback`.
3. **Storage.** Create the KV namespace and the D1 database once and put their ids into
   `wrangler.jsonc` (they are not secrets): `bunx wrangler kv namespace create stalwart-mcp-oauth`
   and `bunx wrangler d1 create stalwart-mcp`. If the data has to stay in a region, add
   `--jurisdiction eu` to both now; it cannot be added later (see "Where the data lives").
   Then apply the migration: `bun run migrate`.
4. **Connect the repository** (Cloudflare dashboard, Workers & Pages, import a repository):
   worker name `stalwart-mcp` (the `name` in `wrangler.jsonc`), deploy command
   `bun run deploy`. From then on every push to the connected branch deploys; nothing is
   uploaded by hand.
5. **Secrets** (in the dashboard, or `bunx wrangler secret put <NAME>`):
   - `STALWART_OAUTH_CLIENT_SECRET`: the client secret from step 2.
   - `TOKEN_ENC_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). Changing it later
     makes every stored mailbox token unreadable: every mailbox is disconnected.
6. **Dashboard variable**, optional (kept across deploys by `keep_vars`): `DISABLED_FEATURES`,
   see [Contacts and calendars](#contacts-and-calendars).

   Until the client id and both secrets are set, every endpoint answers 503, with
   `config_error <setting>` in the worker's logs. A freshly created worker therefore serves
   nothing, and it opens by itself once the second secret is in place.
7. Check that the Durable Object migration `v1` was applied (the `MailboxVault` class exists
   with SQLite storage), then work through the live checks below with a test mailbox.

### Trying it first

Few people run a second mail server, so a trial usually talks to the real one. For that, set
`ENVIRONMENT` to `staging`, for example in a second worker with its own name, storage and OAuth
client. A staging deployment answers under the origin of the request (its `workers.dev`
address will do) and needs no `PUBLIC_ORIGIN`, and it obeys two more dashboard variables:

- `SIGNIN_ALLOWLIST`: comma-separated mailbox addresses that may connect.
- `SEND_ALLOWLIST`: comma-separated addresses mail may go to. This covers `send_mail` and the
  participants of every event write that makes the mail server notify.

Both lists are enforced in code. If a list is empty, nobody can connect and nothing is sent.
This is what makes it safe to point a trial at your one, real mail server. In production both
lists are ignored.

### Contacts and calendars

Mail is always offered, and so are contacts and calendars unless you switch them off with the
dashboard variable `DISABLED_FEATURES`: `contacts`, `calendars` or `contacts,calendars` (spaces
are ignored; empty or unset switches nothing off). Any other name, `mail` included, closes the
worker with 503 and `config_error DISABLED_FEATURES` in its logs, so a typo never quietly asks
Stalwart for more than you meant. An area that is off has no tools, is not asked of Stalwart
and is not named on the approval page.

- **Scopes.** Each area that is on makes the worker ask Stalwart for one more scope at sign-in:
  `urn:ietf:params:oauth:scope:contacts` and `urn:ietf:params:oauth:scope:calendars`
  (`STALWART.scope` in `src/stalwart/endpoints.ts`). The OAuth client on Stalwart has to be
  allowed to grant them. The approval page names each area, so the user knows what the tool
  gets.
- **After switching an area back on, connected mailboxes must connect again.** Their Stalwart
  token was issued without that scope. Until then the new tools answer with the fixed message "This
  connection does not include that permission. Remove the connector in your AI tool and connect
  the mailbox again." (`not_granted`, audited as `refused`), and send nothing to Stalwart.
  Mail keeps working.
- **Reach of the token.** As with mail, which also opens IMAP and SMTP, the scopes are Stalwart's,
  not the connector's: according to Stalwart's documentation a vault token with the contacts or
  calendars scope also reaches CardDAV and CalDAV for that account. The connector sends JMAP
  `/get` and `/query`, and `/set` of `ContactCard` and `CalendarEvent` only; the tests assert that
  no request contains another `/set`, a `/copy` or a `/parse` method, and that the read tools
  send no `/set` at all.
- **Writing.** `create_*`, `update_*` and `delete_*` write into the mailbox's own address books
  and calendars (the default one unless an id of the account is given). An update replaces each
  given field as a whole and leaves the others. Deleting is permanent: there is no trash for
  contacts and events, and the tool descriptions and the approval page say so. Up to 50 ids per
  delete call, no daily limit on deleting. A create whose outcome is unknown (timeout, network
  error, 5xx) is never retried: it answers a temporary error (or, when it would notify people,
  `send_unconfirmed`), and the tool description says to look before creating again. Single-line
  text (names, title, location, organization, job title, phone number) may carry no control,
  line or paragraph separator or bidi control character; `notes` and `description` may also
  carry line breaks and tabs.
- **Invitations are mail.** An event with participants is created with the mailbox as organizer,
  and the request asks the mail server to schedule (`sendSchedulingMessages: true`): Stalwart
  itself then sends invitations, updates and cancellations (iTIP) by email from the mailbox. The
  connector decides per write whether it notifies: a create with participants, an update of an
  event that has attendees before or after it, a deletion of an event with attendees, each only
  when the event does not end in the past (a recurring event never counts as past; when unsure,
  it counts as notifying). Every other write asks the server not to schedule. A notifying write
  counts as one send against the mailbox's 50 per day, shared with `send_mail`, or one per
  started ten addresses when it involves more than 10 (an existing event created elsewhere); if
  that many are not left, it is refused with `send_limit_reached` and nothing is written (a
  deletion of several such events needs the sum, or nothing is deleted). A notifying create or
  update is deduplicated like a send (the same request within 10 minutes returns the first
  result with `deduplicated: true` and sends nothing). An unknown outcome of a notifying
  create, update or delete (no readable answer, or an answer that names the event nowhere) is
  `send_unconfirmed`: the sends stay counted and, for a create or update, the same request is
  blocked for the window.
  **Outside production only addresses on `SEND_ALLOWLIST` may be notified**, checked for every
  address involved before anything is written, also for an existing event's attendees when it
  is changed or deleted. The connector's event writes of one mailbox run one after the other, so
  none of them can change an event between another's check and its write. Audit rows of the event writes
  carry how many addresses that call notified (`recipient_count`; 0 for a deduplicated one, the
  count is in the first call's row), never an address.
- **Someone else's meetings.** The mailbox organizes an event when its organizer
  (`organizerCalendarAddress`) is the mailbox's own address (any case, without `mailto:`) or it
  has none. For an event organized by someone else, `update_event` with `participants` or
  `recurrence` is refused (`invalid_input`, nothing written); any other change and a deletion
  only affect the mailbox's own copy: written with `sendSchedulingMessages: false`, no send
  counted, `invitations: 0` / `cancellations: 0`, and the organizer is not informed.
- **Replacing participants.** `participants` in `update_event` replaces the list; an attendee
  whose address is already on the event keeps the answer it gave (`participationStatus`) and its
  name when the input gives none. Only new addresses start as `needs-action`, asked to reply.
- **Property names.** Stalwart 1.x implements the newer JSCalendar names and silently stores
  any unknown property as inert data, so a wrong name never fails, it just does nothing. The
  connector writes `calendarAddress` (`mailto:` URI) for participants, `organizerCalendarAddress`,
  one `recurrenceRule` object (with `byDay` entries `{ "@type": "NDay", "day": "mo" }` and `until`
  as the end of that day in the event's zone), and never `uid` (the server makes one),
  `isOrigin`, `sendTo`, `replyTo` or `recurrenceRules`. When reading it still accepts
  `recurrenceRules`, a participant's `email` and `sendTo.imip` as fallbacks.
- **Event time.** A timed event is stored as the wall-clock `start` of the input instant in its
  `time_zone` and a `duration` whose days are wall-clock days in that zone and whose rest is
  exact time (so an event across a daylight-saving change ends at the given instant). Without
  `time_zone`, `create_event` uses `Etc/UTC`; `update_event` keeps the event's stored zone (so a
  weekly Europe/Berlin meeting stays at its local time after the next daylight-saving change),
  and only an event without one (floating) gets `Etc/UTC`. `time_zone` must be an IANA name
  (`Area/Location`, or `UTC`); offsets and abbreviations (`+01:00`, `GMT`, `EST`) are refused,
  and the canonical spelling is written (`europe/berlin` becomes `Europe/Berlin`, `UTC` becomes
  `Etc/UTC`). A wall-clock time that occurs twice (when the clocks go back) means its first
  occurrence, as RFC 5545 and RFC 8984 say. Timed events take years 1000 to 9999. An all-day event is a floating `start` at midnight with `P<days>D` and
  `showWithoutTime: true`. An occurrence id (as `search_events` lists it) changes or deletes
  that occurrence only.
- **What the tools return.** Every result leads with a fixed `content_notice` saying that names,
  titles, descriptions, notes, locations and addresses may come from third parties (for example
  the sender of an invitation) and are data, not instructions. Text is stripped of control and
  bidi characters and capped; an HTML description is reduced to text; a meeting link is kept
  only when it is an http or https URL.
- **Times.** `search_events` takes `after` and `before` as ISO date-times with an offset, converts
  them to UTC and sends them to Stalwart as local times in `Etc/UTC`. `start` and `end` in the
  results are the server's `utcStart` and `utcEnd`; `local_start` and `time_zone` are the event's
  own. All-day events carry `all_day: true`. The recurrence summary of `read_event` is built from
  the first rule's own fields only (for example `weekly, every 2, on mo th, until 2027-01-01`,
  with `2tu` for the second Tuesday and `-1fr` for the last Friday of the month or year); the tool
  does not expand rules itself, the server does (`expandRecurrences`).

### Branding

The pages a user sees in the browser (the approval page and its error pages) take their look
from `src/oauth/theme.ts` and the files in `public/brand/`: wordmark, colours, two fonts, an
icon and the artwork on the right half of wide screens. Both carry exciting IT's branding as
shipped; change the values and replace the files for your own deployment. The fonts are under
the SIL Open Font License (texts next to the files). The pages run no script and load nothing
from another origin, which their Content-Security-Policy enforces.

The same mark is there as a PNG (`public/brand/icon.png`) and as `public/favicon.ico`. The
server names the PNG as the connector's icon to AI tools, and its address
(`<PUBLIC_ORIGIN>/brand/icon.png`) can be entered as the logo of the OAuth client at Stalwart.
Whether a tool shows an icon, and which one, is up to that tool. In the same way the server's
title carries the mailbox address ("<connector name> (<address>)"), so a tool that shows it
can tell two connected mailboxes apart.

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

For contacts and calendars (unless both are switched off), also these (the tests cannot tell, because the stand-in is written from the
same assumptions as the code):

- [ ] Stalwart accepts the two extra scope names at sign-in (`urn:ietf:params:oauth:scope:contacts`, `urn:ietf:params:oauth:scope:calendars`), its consent page names them, and the OAuth client is allowed to grant them. Until this passes on staging, leave `FEATURES` out of production: a scope the client may not grant fails every sign-in, mail included.
- [ ] A token without the contacts or calendars scope gets a session that does not list that capability (the connector's permission check rests on this).
- [ ] The JMAP session lists `urn:ietf:params:jmap:contacts` and `urn:ietf:params:jmap:calendars`
  as capabilities, and the keys of `primaryAccounts` for them are those same URNs. The connector
  reads the capabilities of the token from `primaryAccounts`; a different key means the tools
  answer `not_granted` although the scope was granted.
- [ ] A token with only the mail scope really gets none of the two URNs, and its contacts or
  calendar methods answer `unknownMethod`.
- [ ] Which draft revision of JMAP Calendars the server implements, and that `Calendar/get`
  accepts the properties asked for (`id`, `name`, `description`, `color`, `isDefault`,
  `timeZone`, `myRights`) and answers `myRights` with `mayWriteAll` or `mayWriteOwn`.
- [ ] `CalendarEvent/query` accepts `expandRecurrences: true` with `timeZone: "Etc/UTC"`, a
  single filter condition with `after` and `before` as local times without offset, and the
  filter key `inCalendar` (singular). Check that a daily or weekly series gives one id per
  occurrence, and that the occurrence ids contain only letters, digits, `-` and `_` (the tools
  refuse other ids as input, and an id that fails this makes the search answer a fixed error).
- [ ] `CalendarEvent/get` returns `utcStart` and `utcEnd` when asked for, and `read_event` on an
  occurrence id returns that occurrence (own `start`, `recurrenceId`, no rules). Asking for
  `utcStart` together with `recurrenceOverrides` is refused by the server, which is why the
  connector never asks for `recurrenceOverrides`.
- [ ] Events in a time zone with a daylight-saving change, all-day events (`showWithoutTime`),
  and events spanning midnight: `start`, `end` and the overlap with the window are right.
- [ ] `ContactCard/query` accepts the filter keys `text`, `name`, `email`, `phone`,
  `organization` and `inAddressBook`, rejects other keys with `unsupportedFilter`, and how its
  string filters match (substring or prefix; the tool description does not promise either).
- [ ] `AddressBook/get` and `Calendar/get` with an id of another account answer a not-found, so
  a foreign `address_book_id` or `calendar_id` gives an empty page.
- [ ] The Stalwart access token of a contacts or calendars grant: how long it keeps working after
  the application is removed (as for mail above), and that CardDAV and CalDAV accept it.
- [ ] Contact writes: `ContactCard/set` accepts a client-supplied `uid`; an update replacing a
  whole property (a PatchObject with a top-level key) works as assumed; how the default address
  book and calendar are marked (`isDefault`).
- [ ] An invitation actually arrives at an allow-listed address and names the mailbox as
  organizer; an update and a cancellation arrive too.
- [ ] An attendee on the same Stalwart server is notified (delivered internally, not only by SMTP).
- [ ] The server does not notify for an event that ended in the past, nor for a write sent with
  `sendSchedulingMessages: false` on an event with participants.
- [ ] `recurrenceRule` (with `byDay`, `count`, `until`) is stored and expanded by
  `CalendarEvent/query`; `until` written as `<date>T23:59:59` includes that day.
- [ ] The nominal-day `duration` the connector writes (for example `P2DT1H`) ends where intended
  across a daylight-saving change.
- [ ] Deleting an occurrence id adds an excluded override and leaves the series; changing one
  changes only that occurrence.
- [ ] What the server does when it cannot send an invitation: `noSupportedScheduleMethods`
  (the tool answers a fixed refusal), or saving the event silently without sending.
- [ ] An update or a deletion of an event the mailbox was invited to (organized by someone
  else), which the connector sends with `sendSchedulingMessages: false`: the server sends nothing
  to the organizer or the other attendees, and changes only the mailbox's copy.

Repeat them after a Stalwart upgrade.

## Runbook

**Block one mailbox.** In the D1 database (`stalwart-mcp`):

```sql
INSERT INTO blocked_accounts (key, reason, created_at)
VALUES ('<account id or lower-case address>', '<short reason>', <unix seconds>);
```

`key` is the Stalwart account id or the address **in lower case**. To find the account id of an
address, look in the audit log:
`SELECT DISTINCT account_id FROM audit_log WHERE lower(email) = lower('<address>');`
A blocked mailbox cannot sign in and every tool call is refused.

**Unblock.** `DELETE FROM blocked_accounts WHERE key = '<the same key>';`

**End all access at once.** There is no switch for it; pick by how final it should be:

- *Stop serving, keep the connections:* remove the custom domain from the worker in the
  Cloudflare dashboard (Settings, Domains & Routes). No request reaches the worker; nothing
  stored changes. The next deploy puts the domain back, so pause the build connection too.
- *Cut every mailbox off:* replace `TOKEN_ENC_KEY`. Every stored mailbox token becomes
  unreadable, so every tool call fails until the user connects the mailbox again. This cannot
  be undone.

Deleting the OAuth client on Stalwart does **not** clear connections or worker grants: a
deleted client answers `invalid_client`, which the worker deliberately does not treat as a dead
mailbox grant (otherwise one wrong secret would wipe every mailbox). Tool calls then fail with
a temporary error until the client exists again.

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

**Everything answers 503.** Look for `config_error <setting>` in the worker's logs:
`STALWART_ORIGIN` or `PUBLIC_ORIGIN` is missing or not an https origin, `DATA_JURISDICTION` is
not one of Cloudflare's, `DISABLED_FEATURES` names something unknown, or
`STALWART_OAUTH_CLIENT_ID`, `STALWART_OAUTH_CLIENT_SECRET` or `TOKEN_ENC_KEY` is not set. In
production a request under a host other than `PUBLIC_ORIGIN` answers 404.

## Known limits

- Stalwart's `mail` scope also covers IMAP, SMTP submission and ManageSieve and cannot be
  narrowed to JMAP. Anyone who took over this worker and its secrets could act as every
  connected mailbox. Mitigations: two secrets per deployment, replacing `TOKEN_ENC_KEY`, and
  deleting the OAuth client.
- Contacts and calendars cover the mailbox's own account: no shared address books or calendars
  of other accounts, no free/busy lookups, no answering invitations. Deleting a contact or an
  event cannot be undone. An event update with `participants` replaces the whole list (kept
  attendees keep their answers) and is refused for a meeting someone else organized; a contact
  update rebuilds the name from the parts given. A
  recurring event is
  expanded by the server for the requested window only; `search_events` pages by `offset`, so a
  change between two pages can shift the entries.
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
- A contacts or calendar tool that answers "This connection does not include that permission"
  right after a fresh connect does not need another reconnect: the server either does not list
  the capability for that token or does not implement the method (for example another draft of
  JMAP for Calendars). The connector cannot tell these apart from a connection made while the
  area was switched off.
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
