# Security

This worker holds OAuth tokens for mailboxes, so reports about it are welcome and taken
seriously.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: the **Security** tab
of this repository, then **Report a vulnerability**. Describe what you found, how to reproduce
it and what an attacker gains. You will get an answer within a few days.

Reports about a deployment you do not run yourself (for example someone's mail server) belong
to that deployment's operator, not here.

## What is in scope

- Anything that lets one mailbox reach another mailbox's data.
- Anything that lets an AI tool, or a web page, obtain a Stalwart token or act without the
  mailbox owner's approval.
- Ways around the limits, the block list or the allow-lists of a trial deployment.
- Mailbox content (subjects, bodies, addresses, search terms) ending up in logs or audit rows.

The security model and its known limits are described in `docs/design.md` and in the README
under "Known limits".

## Supported versions

Only the latest commit on `main` is supported.
