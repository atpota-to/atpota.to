---
description: Use when a handle stopped resolving, an account seems to have moved or disappeared, a DID looks wrong, or someone is troubleshooting handle verification and server migration.
---

# Identity troubleshooting

Identity problems in atproto are almost always one of four things. Work the list
in order and report what you find at each step rather than jumping to a
conclusion.

## The sequence

1. **Does the DID resolve?** `resolve_identity`. If the DID resolves and the
   handle does not, the account is fine and the handle binding is broken. That is
   the common case and it is fixable by the account owner.
2. **What does the identity history say?** `get_identity_history`. This shows
   handle changes, PDS changes, and rotation events with timing. Most "what
   happened to this account" questions are answered here.
3. **Where is the repo now?** `describe_pds` and `describe_repo`. If the DID
   points at a PDS that does not have the repo, a migration is in progress or
   went wrong.
4. **Is the repo actually there?** `describe_repo`. An existing DID with no
   reachable repo is a different failure from a DID that never existed.

## What to report

Say what resolved and what did not, in that order, then what it means. For
example: "the DID resolves, the identity history shows a handle change three days
ago, and the old handle is not bound to anything now. Whoever you are looking for
is at the new handle."

## Boundaries

- These are read-only tools. You can diagnose, you cannot fix. Say who can:
  usually the account owner through their PDS or their client's settings, or a
  domain DNS record for a custom handle.
- Do not guess why someone migrated, changed handles, or disappeared. Report the
  events and their timing and stop there.
- A DID that never existed and a DID that was deleted look similar from outside.
  Do not claim to know which.
- Custom-domain handle verification failures are usually DNS or the
  `/.well-known/atproto-did` file. You can say that is where to look. You cannot
  read their DNS.
