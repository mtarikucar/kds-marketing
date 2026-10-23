# Mail adapter

`MailConnector::new(Arc<Egress>)` implements `Connector`, `MailSender` and `MailboxPoller`
and is registered in the production and scripted registries for `Provider::Mail`. Share the
`Egress` used by `EgressTenantHosts`; send and poll receive the caller's `WorkspaceId` on every
invocation. Probe and connection hooks require `public.workspace_id`, inserted authoritatively
from the capability by `adapter_public`. Poll's explicit workspace takes precedence over any
public metadata. Register both credential hosts in the tenant registry and persist them in
`connector_public.hosts` during capability provisioning. `hosts()` is empty: mail has no fixed
provider hosts. Revocation/rebuild of that registry affects subsequent socket opens immediately.

`Egress::connect_public(scope, host, port, timeout)` is a method because the tenant registry is
instance-owned. It checks that registry, uses the shared `resolve_public` filtering path, and
connects only to returned addresses within a maximum ten-second deadline. It rechecks permission
after resolution and the handshake. It never resolves a name a second time.

Mail credentials select implicit TLS (SMTP 465, IMAP 993) or mandatory STARTTLS (587, 143).
Ephemeral ports on `localhost` are accepted only in builds with the dev-only egress loopback
feature. Both modes verify the declared host and a trusted certificate chain. An additional DER
CA can be supplied through `with_root_certificate`; this never disables hostname verification.

The probe authenticates IMAP and reports that login as `facts.account_id`; it independently
checks SMTP AUTH and MAIL FROM acceptance. Sending preserves the caller's persisted Message-ID,
thread headers and MIME attachments. A lost/malformed response or timeout after DATA is `Unknown`,
never automatically retried. A conclusive SMTP refusal retains its permanent/transient meaning.

Polling discovers the Sent folder through LIST special-use flags (with common-name fallbacks),
and reads it and INBOX with BODY.PEEK. Missing Sent folders do not block INBOX. Each actual folder
has an independent UIDVALIDITY/UID cursor. UIDNEXT bounds discovery. When ESEARCH is advertised,
`UID SEARCH RETURN (MIN) UID <last+1>:*` locates the next existing UID before windowed fetching.
Otherwise, `UID SEARCH UID a:b` starts with a 5,000-UID window and doubles after empty ranges.
SEARCH responses retain at most 1,000 UIDs while streaming; larger results are drained and
retried on the lower half. Only completely scanned accepted ranges can advance the cursor.
The shared poll limits are 20 window searches (including bisection retries) and 100 messages.
The reader validates ESEARCH's UID marker and optional command tag, preserves fragmented
unsolicited responses and opaque literals across mode changes, and retains size metadata preflight,
partial body fetches, and a shared 20 MiB poll budget. Operations have ten-second deadlines;
discovery reserves two seconds of the eight-second poll budget for fetching. If one slow
SEARCH overruns that reserve, one bounded fetch still makes progress before yielding. A known
ESEARCH minimum remains eligible for fetching immediately. If no UID is selected yet, overflow
bisection can finish beyond the soft time budget, still subject to the 20-search limit. Completed
polls drop their session without waiting for LOGOUT.
Mail over 10 MiB or malformed/excessively complex MIME produces a metadata-only `mail_rejected`
event and advances that UID, so one poison message cannot block later mail. A byte ceiling below
the protocol parser also limits dishonest server responses. Persist the returned cursor atomically with the event drafts. Changed
UIDVALIDITY starts a new generation. The cursor advances to the highest processed UID or the
end of a fully scanned empty range, never past UIDNEXT-1 or across an unprocessed selected UID.
A message limit reached within a window leaves its remaining UIDs for the next poll. Event IDs are `imap:<account>:<binding>:<mailbox>:<uidvalidity>:<uid>`;
`binding` is the first 12 lowercase hex characters of SHA-256 of `imap_host:imap_port`, with
the host trimmed and ASCII-lowercased. Switching servers therefore cannot collide with stored
events, including rejected mail. Old IDs remain readable as opaque legacy IDs without migration;
the standalone `parse_message` helper retains the legacy format.
`public.external_id` must be the capability's external account ID. Sent evidence emits a `sent`
status with the stable Message-ID. Failed DSNs use the original message's ID. Explicit withdrawal
requests emit consent events; a newsletter's List-Unsubscribe advertisement alone does not
withdraw anyone's consent. HTML-only mail receives a bounded HTML-to-text fallback; a plain-text
alternative takes precedence. Attachments enter events as filename/size only, never their contents.
Outbound encoded MIME is also capped at 10 MiB before connecting so Sent copies remain pollable.

Errors use adapter-owned messages, never server replies. Credential Debug masks login/password.
The IMAP dependency traces raw LOGIN and MIME at `log::trace!`; this crate enables
`log/max_level_debug` to compile those records out in all profiles. This caps the **log facade**
at debug throughout the dependency graph; application `tracing` diagnostics are unaffected.
Architecture tests keep protocol dependencies private to this adapter and prohibit alternate
socket openers or permissive TLS verification.

Tests use synthetic MIME and local TLS servers. The checked-in CA/server/private-key DER files
are public test fixtures only, valid for localhost; the wrong-host fixture tests name rejection.
