//! Buffered fake implementation of the complete erasure inventory.
use super::state::MemState;
use jt_app::usecases::inbox::erasure::mask_personal;
use jt_inbox::*;
use jt_tenancy::WorkspaceId;
use serde_json::json;

pub(super) fn scrub(s: &mut MemState, ws: WorkspaceId, person: PersonId) {
    let identities: Vec<_> = s
        .inbox
        .identities
        .iter()
        .filter(|i| i.workspace_id == ws && i.person_id == person)
        .cloned()
        .collect();
    let convs: Vec<_> = s
        .inbox
        .conversations
        .iter()
        .filter(|c| c.workspace_id == ws && c.person_id == person)
        .map(|c| c.id)
        .collect();
    let journeys: Vec<_> = s
        .inbox
        .journeys
        .iter()
        .filter(|j| j.workspace_id == ws && j.person_id == person)
        .map(|j| j.id)
        .collect();
    let messages: Vec<_> = s
        .inbox
        .messages
        .iter()
        .filter(|m| m.workspace_id == ws && convs.contains(&m.conversation_id))
        .map(|m| m.id)
        .collect();
    let matched: Vec<_> = s
        .inbound_events
        .iter()
        .filter(|row| {
            let e = &row.event;
            if e.workspace_id != ws {
                return false;
            }
            if e.payload["person_id"] == json!(person) {
                return true;
            }
            let cap = s
                .capabilities
                .iter()
                .find(|c| {
                    c.capability.workspace_id == ws && Some(c.capability.id) == e.capability_id
                })
                .map(|c| &c.capability);
            let namespace = cap.and_then(|c| match c.kind_key.as_str() {
                "facebook_page" => Some(IdentityChannel::Messenger),
                "instagram" => Some(IdentityChannel::InstagramDm),
                kind => channel_for_kind(kind).map(Channel::identity_channel),
            });
            let recipient_namespace = match e.payload["channel"].as_str() {
                Some("EPOSTA") => Some(IdentityChannel::Email),
                Some("MESAJ" | "ARAMA") => Some(IdentityChannel::Phone),
                _ => namespace,
            };
            let cdr = (e.payload["scenario"] == "cdr").then_some(IdentityChannel::Phone);
            [
                ("/from", namespace),
                ("/to", namespace),
                ("/recipient", recipient_namespace),
                ("/source", cdr),
                ("/destination", cdr),
                ("/customer_num", Some(IdentityChannel::Phone)),
                ("/email", Some(IdentityChannel::Email)),
                ("/phone", Some(IdentityChannel::Phone)),
                ("/message/from", Some(IdentityChannel::Phone)),
                ("/messaging/sender/id", namespace),
                ("/messaging/recipient/id", namespace),
                ("/sender/id", namespace),
                ("/recipient/id", namespace),
                ("/status/recipient_id", Some(IdentityChannel::Phone)),
            ]
            .iter()
            .filter_map(|(path, channel)| Some((e.payload.pointer(path)?.as_str()?, (*channel)?)))
            .any(|(candidate, channel)| {
                identities.iter().filter(|i| i.channel == channel).any(|i| {
                    if channel == IdentityChannel::Email {
                        return candidate
                            .split(|c: char| c.is_whitespace() || "<>,;:\"".contains(c))
                            .any(|v| {
                                normalise(channel, v).ok().as_deref() == Some(&i.value_normalized)
                            });
                    }
                    normalise(channel, candidate).ok().is_some_and(|v| {
                        let v = if channel == IdentityChannel::Phone {
                            v
                        } else {
                            scope_opaque(
                                cap.and_then(|c| c.external_id.as_deref()).unwrap_or(""),
                                &v,
                            )
                        };
                        v == i.value_normalized
                    })
                })
            })
        })
        .map(|e| e.event.id)
        .collect();
    let batches: Vec<_> = s
        .inbound_events
        .iter()
        .filter(|e| matched.contains(&e.event.id))
        .filter_map(|e| e.raw.clone())
        .collect();
    for e in &mut s.inbound_events {
        if e.event.workspace_id != ws {
            continue;
        }
        if e.raw.as_ref().is_some_and(|raw| batches.contains(raw)) {
            e.raw = None;
        }
        if matched.contains(&e.event.id) {
            e.raw = None;
            mask_personal(&mut e.event.payload);
            e.event.payload["person_id"] = json!(person);
        }
    }
    for p in &mut s.probe_runs {
        if p.workspace_id == ws && p.facts["person_id"] == json!(person) {
            p.facts = json!({"person_id":person});
        }
    }
    for e in &mut s.inbox.events {
        if e.workspace_id == ws && journeys.contains(&e.journey_id) {
            if let JourneyEventKind::Won { product, .. } = &mut e.kind {
                product.clear();
            }
            e.reason_label = None;
        }
    }
    for j in &mut s.inbox.journeys {
        if j.workspace_id == ws
            && j.person_id == person
            && let Some(reason) = &mut j.lost_reason
        {
            reason.reason_label.clear();
        }
    }
    for t in &mut s.inbox.tasks {
        if t.workspace_id == ws && journeys.contains(&t.journey_id) {
            t.title.clear();
        }
    }
    for n in &mut s.inbox.notes {
        if n.workspace_id == ws && journeys.contains(&n.journey_id) {
            n.text.clear();
        }
    }
    for q in &mut s.inbox.quotes {
        if q.workspace_id == ws && journeys.contains(&q.quote.journey_id) {
            q.quote.file_ref = None;
        }
    }
    for a in &mut s.inbox.appointments {
        if a.workspace_id == ws && journeys.contains(&a.appointment.journey_id) {
            a.appointment.location.clear();
        }
    }
    for o in &mut s.inbox.outbox {
        if o.workspace_id == ws && convs.contains(&o.conversation_id) {
            o.intent = match o.intent["mail"]["message_id"].as_str() {
                Some(id) => json!({"mail":{"message_id":id}}),
                None => json!({}),
            };
            o.fence_snapshot = None;
            o.last_error = None;
            if o.state == "queued" {
                o.state = "refused".into();
            }
        }
    }
    for j in &mut s.outbound_jobs {
        if j.workspace_id == ws && j.row.message_id.is_some_and(|m| messages.contains(&m)) {
            j.row.last_status = None;
            j.status = None;
            if j.row.state == jt_app::ports::compliance::OutboundJobState::Queued {
                j.row.state = jt_app::ports::compliance::OutboundJobState::Refused;
            }
        }
    }
    for m in &mut s.inbox.messages {
        if messages.contains(&m.id) {
            m.body.clear();
        }
    }
    s.inbox.message_senders.retain(|m, _| !messages.contains(m));
    for c in &mut s.inbox.conversations {
        if convs.contains(&c.id) {
            c.executor_generation += 1;
        }
    }
    for (id, state) in &mut s.inbox.conversation_send_states {
        if convs.contains(id) {
            state.last_inbound_identity_id = None;
        }
    }
    for m in &mut s.inbox.merges {
        if m.workspace_id == ws && (m.source_id == person || m.target_id == person) {
            m.moved_snapshot = json!({});
            m.conflicts.clear();
            m.decision = MergeDecision::Suggest(vec![]);
        }
    }
    s.inbox.request_keys.retain(|r| {
        r.workspace_id != ws
            || !(r.response["person_id"] == json!(person)
                || convs.iter().any(|c| {
                    r.response["conversation_id"] == json!(c)
                        || r.response["reply"]["conversation_id"] == json!(c)
                })
                || journeys.iter().any(|j| {
                    r.response["journey_id"] == json!(j)
                        || r.response["quote"]["journey_id"] == json!(j)
                }))
    });
    for p in &mut s.inbox.people {
        if p.workspace_id == ws && (p.id == person || p.merged_into == Some(person)) {
            p.display_name = "silinmiş kişi".into();
            p.company.clear();
        }
    }
    s.inbox
        .identities
        .retain(|i| i.workspace_id != ws || i.person_id != person);
}
