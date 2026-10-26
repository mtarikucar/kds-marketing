#!/usr/bin/env bash
# Offline procedure model, not a production cutover command.
set -euo pipefail
umask 077
shopt -s globstar nullglob
rehearsal_root=$(mktemp -d)
trap 'chmod -R u+rwX "$rehearsal_root"; rm -rf "$rehearsal_root"' EXIT
state=

fail() { printf 'FAIL %s: %s\n' "${case_name:-setup}" "$*" >&2; exit 1; }
equal() { [[ "$1" == "$2" ]] || fail "expected [$2], got [$1]"; }
put() { printf '%s\n' "$2" > "$state/$1"; }
get() { cat "$state/$1"; }
same_bytes() {
  local first second
  first=$(sha256sum "$1") || return 1
  second=$(sha256sum "$2") || return 1
  [[ "${first%% *}" == "${second%% *}" ]]
}
snapshot() {
  local file
  local -a files=() entries=("$state"/**/*)
  stat -c '%a %n' "${entries[@]}"
  for file in "$state"/**/*; do
    [[ -f "$file" ]] || continue
    files+=("$file")
  done
  sha256sum "${files[@]}"
}
refused() {
  local before status
  before=$(snapshot)
  if "$@"; then fail "unsafe operation accepted: $*"; else status=$?; fi
  equal "$status" 1
  equal "$(snapshot)" "$before"
}

# Two installations, a private change record, and a recording provider. These
# identifiers are labels, not credentials, URLs, real accounts or activation codes.
history_kinds=(people conversations mail payments publications queues learning ledger sessions invitations sealed_credentials messages codes grants audit)
setup() {
  state="$rehearsal_root/$case_name"
  mkdir -p "$state"/{v1/data,v2/data,record,provider}
  local kind
  for kind in "${history_kinds[@]}"; do
    put "v1/data/$kind" "v1-$kind"
    : > "$state/v2/data/$kind"
  done
  put v1/identity 'old-workspace|old-membership|old-key|old-capability'
  put v1/sender 1; put v1/polls 1
  put v2/sender 0; put v2/polls 0
  put phase initial
  put record/owner owner-example
  put record/gap_owner owner-example
  put record/switch_time '2030-01-01T12:00:00Z'
  put record/old_app app-v1-example
  put record/new_app app-v2-example
  put record/old_account account-example
  put record/new_account account-example
  put record/review approved
  for kind in callback dns proxy hook; do
    put "record/old_$kind" "$kind-v1-example"
    put "record/new_$kind" "$kind-v2-example"
  done
  for kind in callbacks hooks identity; do put "record/$kind" verified; done
  for kind in callback dns proxy; do put "provider/$kind" "$(get "record/old_$kind")"; done
  put provider/webhook v1
  put provider/target "$(get record/old_hook)"
  : > "$state/provider/calls"
  : > "$state/provider.log"
  fresh_start
  trace initial
}

phase_is() { [[ "$(get phase)" == "$1" ]]; }
both_stopped() {
  [[ "$(get v1/sender)$(get v1/polls)$(get v2/sender)$(get v2/polls)" == 0000 ]]
}
trace() {
  printf '%s|%s|%s|%s|%s|%s\n' "$1" "$(get v1/sender)" "$(get v2/sender)" \
    "$(get v1/polls)" "$(get v2/polls)" "$(get provider/webhook)" >> "$state/provider.log"
}
fresh_is_clean() {
  local kind
  for kind in "${history_kinds[@]}"; do
    [[ ! -s "$state/v2/data/$kind" ]] || return 1
  done
  [[ "$(get v1/identity)" != "$(get v2/identity)" ]]
}
fresh_start() {
  phase_is initial || return 1
  put v2/identity 'new-workspace|new-membership|new-key|reconnected-capability'
}
import_v1() {
  # No field is allowlisted by this dispatch; a separate amended brief is needed.
  return 1
}
preflight() {
  phase_is initial || return 1
  local field
  for field in owner switch_time gap_owner old_app new_app review old_account new_account old_callback new_callback old_dns new_dns old_proxy new_proxy old_hook new_hook; do
    [[ -s "$state/record/$field" && -n "$(get "record/$field")" ]] || return 1
  done
  [[ "$(get record/new_app)" != "$(get record/old_app)" ]] || return 1
  [[ "$(get record/review)" == approved ]] || return 1
  [[ "$(get record/gap_owner)" == "$(get record/owner)" ]] || return 1
  fresh_is_clean || return 1
  put phase prepared
  trace prepared
}
freeze_v1() {
  phase_is prepared || return 1
  [[ "$(get v2/sender)$(get v2/polls)" == 00 ]] || return 1
  put v1/sender 0; put v1/polls 0
  put phase frozen
  put record/gap "$(get record/gap_owner)|freeze-v1..v2-enabled|reconciliation-pending"
  trace v1-frozen
}
backup_both() {
  phase_is frozen && both_stopped || return 1
  mkdir -p "$state/backups" "$state/archive"
  cp -R "$state/v1" "$state/backups/v1"
  cp -R "$state/v2" "$state/backups/v2"
  cp -R "$state/v1/data" "$state/archive/data"
  put archive/owner "$(get record/owner)"
  put archive/retention_days 90
  chmod 400 "$state/archive/owner" "$state/archive/retention_days" "$state/archive/data/"*
  chmod 500 "$state/archive/data" "$state/archive"
  put phase backed-up
  trace backed-up
}
verify_new() {
  phase_is backed-up && both_stopped || return 1
  local field
  for field in callbacks hooks identity; do
    [[ "$(get "record/$field")" == verified ]] || return 1
  done
  [[ "$(get record/new_account)" == "$(get record/old_account)" ]] || return 1
  [[ "$(get record/review)" == approved ]] || return 1
  put phase verified
  trace verified
}
switch_webhook() {
  phase_is verified && both_stopped || return 1
  # Assignment replaces the one effective destination; there is no fan-out list.
  put provider/webhook v2
  put provider/target "$(get record/new_hook)"
  local kind
  for kind in callback dns proxy; do put "provider/$kind" "$(get "record/new_$kind")"; done
  put phase switched
  trace webhook-v2
}
enable_v2() {
  phase_is switched && both_stopped || return 1
  [[ "$(get provider/webhook)" == v2 ]] || return 1
  put v2/sender 1; put v2/polls 1
  put phase live
  trace v2-enabled
}
provider_send() {
  local other
  case "$1" in v1) other=v2 ;; v2) other=v1 ;; *) return 1 ;; esac
  [[ "$(get "$1/sender")" == 1 && "$(get "$other/sender")" == 0 ]] || return 1
  [[ "$(get provider/webhook)" == "$1" ]] || return 1
  printf '%s %s\n' "$1" "$2" >> "$state/provider/calls"
  trace "send-$1"
}
archive_access() {
  [[ -d "$state/archive" && "$2" == "$(get archive/owner)" ]] || return 1
  case "$1" in
    read) get archive/data/messages ;;
    write) return 1 ;;
    delete)
      # $3 is elapsed whole days since the frozen snapshot, not calendar day.
      [[ "$3" =~ ^[0-9]+$ ]] && (( $3 >= $(get archive/retention_days) )) || return 1
      chmod -R u+rwX "$state/archive"
      rm -rf "$state/archive"
      ;;
    *) return 1 ;;
  esac
}
write_new_data() {
  phase_is live || return 1
  put v2/data/messages v2-message-example
  put v2/data/payments v2-payment-example
  put v2/data/codes v2-code-audit-example
  put v2/data/grants v2-grant-audit-example
  put v2/data/audit v2-audit-example
}
stop_v2() {
  phase_is live || phase_is switched || return 1
  put v2/sender 0; put v2/polls 0
  put phase rollback-stopped
  put record/rollback_gap "$(get record/owner)|v2-stopped..v1-enabled|manual-reconciliation-pending"
  trace v2-stopped
}
preserve_new() {
  phase_is rollback-stopped || phase_is preserved || phase_is decided || return 1
  both_stopped || return 1
  mkdir -p "$state/preserved"
  cp "$state/v2/data/"* "$state/preserved/"
  : > "$state/record/decision"
  put phase preserved
  trace new-preserved
}
new_matches_preserved() {
  local kind
  for kind in "${history_kinds[@]}"; do
    [[ -f "$state/preserved/$kind" ]] || return 1
    same_bytes "$state/v2/data/$kind" "$state/preserved/$kind" || return 1
  done
}
record_decision() {
  phase_is preserved && both_stopped && new_matches_preserved || return 1
  [[ "$1" == "$(get record/owner)" && "$2" == retain-isolated ]] || return 1
  put record/decision "$1|$2|no-merge-no-replay"
  put phase decided
  trace decision-recorded
}
repoint_old() {
  phase_is decided && both_stopped && new_matches_preserved || return 1
  [[ -s "$state/record/decision" ]] || return 1
  put provider/webhook v1
  put provider/target "$(get record/old_hook)"
  put phase repointed
  trace webhook-v1
}
restore_bindings() {
  phase_is repointed && both_stopped || return 1
  [[ "$(get provider/webhook)" == v1 ]] || return 1
  local kind
  for kind in callback dns proxy; do put "provider/$kind" "$(get "record/old_$kind")"; done
  put phase bindings-restored
  trace bindings-v1
}
resume_v1() {
  phase_is bindings-restored && both_stopped && new_matches_preserved || return 1
  [[ "$(get provider/webhook)" == v1 ]] || return 1
  local kind
  for kind in callback dns proxy; do
    [[ "$(get "provider/$kind")" == "$(get "record/old_$kind")" ]] || return 1
  done
  put v1/sender 1; put v1/polls 1
  put phase rolled-back
  trace v1-enabled
}

ready() { preflight; freeze_v1; backup_both; verify_new; }
live() { ready; switch_webhook; enable_v2; }
rollback_ready() { stop_v2; preserve_new; record_decision owner-example retain-isolated; }

assert_single_sender_trace() {
  local event one two poll_one poll_two destination
  while IFS='|' read -r event one two poll_one poll_two destination; do
    (( one + two <= 1 )) || fail "two senders at $event"
    (( poll_one + poll_two <= 1 )) || fail "two pollers at $event"
    if [[ "$two" == 1 || "$poll_two" == 1 ]]; then equal "$destination" v2; fi
    if [[ "$one" == 1 || "$poll_one" == 1 ]]; then equal "$destination" v1; fi
  done < "$state/provider.log"
}

cutover_never_has_two_active_senders() {
  setup
  preflight
  refused enable_v2
  refused switch_webhook
  freeze_v1
  equal "$(get v1/sender)" 0
  equal "$(get v1/polls)" 0
  refused enable_v2
  backup_both
  verify_new
  switch_webhook
  enable_v2
  refused enable_v2
  provider_send v2 synthetic-send
  refused provider_send v1 forbidden-send
  equal "$(get provider/calls)" 'v2 synthetic-send'
  assert_single_sender_trace
}

cutover_records_single_webhook_and_gap_owner() {
  setup
  put record/gap_owner ''
  refused preflight
  put record/gap_owner owner-example
  ready
  switch_webhook
  refused switch_webhook
  equal "$(get provider/webhook)" v2
  equal "$(get provider/target)" hook-v2-example
  equal "$(get record/gap)" 'owner-example|freeze-v1..v2-enabled|reconciliation-pending'
  equal "$(get record/old_app)" app-v1-example
  equal "$(get record/new_app)" app-v2-example
  equal "$(get record/old_account)" account-example
  equal "$(get record/new_account)" account-example
  local count=0 event _rest
  while IFS='|' read -r event _rest; do
    if [[ "$event" == webhook-v2 ]]; then count=$((count + 1)); fi
  done < "$state/provider.log"
  equal "$count" 1
}

cutover_requires_new_reviewed_apps_and_owner_time() {
  local field saved
  setup
  for field in owner switch_time gap_owner new_app review old_callback new_callback old_dns new_dns old_proxy new_proxy old_hook new_hook old_account new_account; do
    saved=$(get "record/$field")
    put "record/$field" ''
    refused preflight
    put "record/$field" "$saved"
  done
  put record/new_app app-v1-example
  refused preflight
  put record/new_app app-v2-example
  put record/review pending
  refused preflight
  put record/review approved
  preflight
  refused backup_both
  freeze_v1
  refused verify_new
  backup_both
  for field in callbacks hooks identity; do
    put "record/$field" failed
    refused verify_new
    put "record/$field" verified
  done
  put record/new_account wrong-account
  refused verify_new
  put record/new_account account-example
  verify_new
  switch_webhook
  enable_v2
}

v1_archive_is_read_only_for_ninety_days() {
  setup
  ready
  local original
  original=$(get archive/data/messages)
  equal "$(archive_access read owner-example 0)" "$original"
  refused archive_access read stranger 0
  refused archive_access write owner-example 0
  refused archive_access write owner-example 89
  refused archive_access delete owner-example 89
  equal "$(stat -c '%a' "$state/archive/data/messages")" 400
  equal "$(stat -c '%a' "$state/archive")" 500
  switch_webhook
  enable_v2
  rollback_ready
  repoint_old
  restore_bindings
  resume_v1
  printf 'runtime-only\n' >> "$state/v1/data/messages"
  equal "$(get archive/data/messages)" "$original"
  refused archive_access write owner-example 90
  refused archive_access delete stranger 90
  archive_access delete owner-example 90
  [[ ! -d "$state/archive" ]] || fail 'archive release did not occur'
}

rollback_repoints_webhooks_before_old_sender_starts() {
  setup
  live
  refused resume_v1
  refused repoint_old
  stop_v2
  refused restore_bindings
  preserve_new
  record_decision owner-example retain-isolated
  refused resume_v1
  refused restore_bindings
  repoint_old
  refused resume_v1
  restore_bindings
  resume_v1
  equal "$(get provider/webhook)" v1
  equal "$(get provider/target)" hook-v1-example
  equal "$(get provider/callback)" callback-v1-example
  equal "$(get provider/proxy)" proxy-v1-example
  equal "$(get provider/dns)" dns-v1-example
  provider_send v1 resumed-send
  assert_single_sender_trace
  local events= event _rest
  while IFS='|' read -r event _rest; do events+="$event "; done < "$state/provider.log"
  [[ "$events" == *'v2-stopped new-preserved decision-recorded webhook-v1 bindings-v1 v1-enabled '* ]] || fail 'rollback order'
}

rollback_preserves_new_payment_and_messages() {
  setup
  live
  write_new_data
  refused preserve_new
  stop_v2
  refused record_decision owner-example retain-isolated
  preserve_new
  record_decision owner-example retain-isolated
  # A late arrival invalidates the captured recovery set and recorded decision.
  printf 'late-message\n' >> "$state/v2/data/messages"
  refused repoint_old
  preserve_new
  record_decision owner-example retain-isolated
  repoint_old
  restore_bindings
  resume_v1
  local kind
  for kind in messages payments codes grants audit; do
    same_bytes "$state/v2/data/$kind" "$state/preserved/$kind" || fail "lost $kind"
    equal "$(get "v1/data/$kind")" "v1-$kind"
  done
  equal "$(get preserved/payments)" 'v2-payment-example'
  equal "$(get preserved/messages)" $'v2-message-example\nlate-message'
  equal "$(get preserved/codes)" 'v2-code-audit-example'
  equal "$(get preserved/grants)" 'v2-grant-audit-example'
  equal "$(get preserved/audit)" 'v2-audit-example'
  equal "$(get record/rollback_gap)" 'owner-example|v2-stopped..v1-enabled|manual-reconciliation-pending'
  [[ ! -s "$state/provider/calls" ]] || fail 'rollback replayed a send'
}

new_data_requires_recorded_rollback_decision() {
  setup
  live
  write_new_data
  stop_v2
  refused repoint_old
  preserve_new
  refused repoint_old
  refused record_decision stranger retain-isolated
  refused record_decision owner-example ''
  refused record_decision owner-example discard
  refused record_decision owner-example merge-into-v1
  record_decision owner-example retain-isolated
  equal "$(get record/decision)" 'owner-example|retain-isolated|no-merge-no-replay'
  repoint_old
  restore_bindings
  resume_v1
}

fresh_start_imports_no_v1_secrets_or_history() {
  setup
  fresh_start
  equal "$(get v2/identity)" 'new-workspace|new-membership|new-key|reconnected-capability'
  local kind
  for kind in "${history_kinds[@]}"; do
    [[ ! -s "$state/v2/data/$kind" ]] || fail "imported $kind"
    refused import_v1 "$kind"
    # Detect contamination as well as declining an import command.
    cp "$state/v1/data/$kind" "$state/v2/data/$kind"
    refused preflight
    : > "$state/v2/data/$kind"
  done
  live
  equal "$(get v2/identity)" 'new-workspace|new-membership|new-key|reconnected-capability'
}

for case_name in \
  cutover_never_has_two_active_senders \
  cutover_records_single_webhook_and_gap_owner \
  cutover_requires_new_reviewed_apps_and_owner_time \
  v1_archive_is_read_only_for_ninety_days \
  rollback_repoints_webhooks_before_old_sender_starts \
  rollback_preserves_new_payment_and_messages \
  new_data_requires_recorded_rollback_decision \
  fresh_start_imports_no_v1_secrets_or_history; do
  "$case_name"
  printf 'PASS %s\n' "$case_name"
done
