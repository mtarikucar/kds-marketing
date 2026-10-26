# Platform operator access

Operators sign in at `/platform/login`, then use `/platform/workspaces`,
`/platform/payments` and `/platform/health`. Operator accounts are separate from
workspace members. They cannot impersonate members or open tenant messages,
notes, raw webhook bodies or connector credentials. There are no platform MCP tools.

The HttpOnly `jt_platform` cookie authenticates operator requests; `jt_session`
authenticates tenant requests. Neither cookie, a tenant bearer token nor an API
key substitutes for the other. Keep TLS and secure cookies enabled in production.
Mutating panel calls require `X-Requested-With: jeeta-panel` in addition to the
operator cookie. An operator session expires after 12 hours.

## First operator

Stop the service. In the protected environment file, set
`JEETA_PLATFORM_BOOTSTRAP_EMAIL` and `JEETA_PLATFORM_BOOTSTRAP_PASSWORD` together.
Use an operator email such as `operator@example.test` (synthetic example only)
and a unique password of at least **12 characters** from your password manager.
Start once and verify login. Stop, remove both variables, and restart. Ordinary
bootstrap does not replace an existing operator or create a second operator on
restart, even if the configured email changes.

## Payment and workspace operations

Compare the payment reference, amount, currency and payment date against bank
records before selecting **Havale doğrulandı**. Confirmation does not activate
the workspace: its owner must redeem the **Etkinleştirme kodu** in the tenant
panel. Deliver that code through an approved private channel. It is displayed
with its expiry only from the confirm/reissue response, and disappears when
leaving the page. Do not paste codes or references into operational logs or
telemetry. A confirmation retry returns current status, without recovering the
code. **Kodu yeniden oluştur** explicitly invalidates the previous code.

**Askıya al** requires a reason and retains the entitlement. **Yeniden aç**
resumes a suspended workspace with an activated entitlement. **Etkinleştirmeyi
geri al** requires a reason, closes the grant and returns the workspace to
pending payment. Refunds happen outside the application. The current payment
list exposes only open grants; “Onay bekliyor veya geri alındı” means no open
grant, not proof that the payment was never confirmed. A separate historical
projection is awaiting the Task 6 review decision.

## Reset by another operator

A different signed-in operator opens **Sistem sağlığı** and the **Parolayı
sıfırla** form, enters the target operator UUID and a new password of at least
12 characters, then submits. The server refuses self-reset and unknown targets.
The password hash update and revocation of **all target sessions** commit
atomically; other operators' sessions remain valid. Hand the new password to
the target through an approved private channel. Never record the password or
hash in a ticket, log or screenshot. The target signs in again with the new
password. The form clears the password when submitted.

This procedure does not create operators. Provisioning additional operators is
outside this console's policy.

## Sole-operator recovery

1. Stop the service with `systemctl stop jeeta`. Ensure no other process serves
   the same database. Keep the protected environment file accessible only to the
   service administrator and service account as described in
   [deployment.md](deployment.md).
2. Set all three variables in that file:
   `JEETA_PLATFORM_BOOTSTRAP_RESET=1`, `JEETA_PLATFORM_BOOTSTRAP_EMAIL` naming
   the existing operator, and `JEETA_PLATFORM_BOOTSTRAP_PASSWORD` holding a new
   password of at least 12 characters. Do not place passwords in shell history.
3. Start once with `systemctl start jeeta`. Recovery locks operator rows,
   requires **exactly one operator with that email**, replaces its hash and
   revokes every session atomically. Zero operators, multiple operators or a
   mismatched email abort startup. Missing credentials, an invalid reset flag
   or a short password also abort startup. Omitted reset flag or `0` selects
   ordinary bootstrap and does not reset an existing password.
4. Verify login with the new password; old credentials and sessions must fail.
   Stop the service, remove **all three** bootstrap variables, then restart and
   verify the new login again. Leaving reset enabled would revoke sessions on
   every restart.

Hashing finishes before the recovery transaction. Login holds the operator row
lock through password verification and session insertion, so an old-password
login already in flight cannot leave a surviving session after reset. Recovery
can commit before a later startup stage fails (for example, listener binding);
check the new credentials before retrying a failed start. Do not manipulate
password hashes or session rows directly. If more than one operator exists,
use a different authenticated operator; if no such account is accessible,
escalate to the service owner for a reviewed recovery decision.
