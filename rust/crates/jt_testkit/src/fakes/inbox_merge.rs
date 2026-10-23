//! Tenant-scoped merge graph snapshots and reversible, buffered mutations.
use super::state::{MemBundle, MemState, exists, same_workspace, unique};
use super::tenant::MemTenant;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::*};
use jt_inbox::*;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;

fn found(ok: bool) -> Result<(), AppError> {
    if ok {
        Ok(())
    } else {
        Err(AppError::not_found("no such merge reference"))
    }
}
fn person(s: &MemState, ws: WorkspaceId, id: PersonId) -> Result<(), AppError> {
    found(
        s.inbox
            .people
            .iter()
            .any(|r| r.workspace_id == ws && r.id == id),
    )
}
fn validate_row(s: &MemState, ws: WorkspaceId, row: &MergeRow) -> Result<(), AppError> {
    same_workspace(ws, row.workspace_id)?;
    person(s, ws, row.source_id)?;
    person(s, ws, row.target_id)?;
    exists(row.source_id != row.target_id, "merges distinct people")?;
    if let Some(id) = row.applied_by {
        exists(s.user(id).is_some(), "inbox.user_id")?;
    }
    Ok(())
}

fn validate_snapshot(
    s: &MemState,
    ws: WorkspaceId,
    snap: &MergeSnapshot,
    restoring: bool,
) -> Result<(), AppError> {
    for id in snap.people {
        person(s, ws, id)?;
    }
    for c in &snap.conversations {
        same_workspace(ws, c.workspace_id)?;
        person(s, ws, c.person_id)?;
        found(
            s.capabilities
                .iter()
                .any(|r| r.capability.workspace_id == ws && r.capability.id == c.capability_id),
        )?;
        if restoring {
            unique(
                !s.inbox
                    .conversations
                    .iter()
                    .any(|r| r.id == c.id && r.workspace_id != ws),
                "conversation id is taken",
            )?;
        } else {
            found(
                s.inbox
                    .conversations
                    .iter()
                    .any(|r| r.workspace_id == ws && r.id == c.id),
            )?;
        }
    }
    for i in &snap.identities {
        person(s, ws, i.person_id)?;
        found(
            s.inbox
                .identities
                .iter()
                .any(|r| r.workspace_id == ws && r.id == i.id),
        )?;
    }
    for j in &snap.journeys {
        person(s, ws, j.person_id)?;
        found(
            s.inbox
                .journeys
                .iter()
                .any(|r| r.workspace_id == ws && r.id == j.id),
        )?;
    }
    for m in &snap.messages {
        found(snap.conversations.iter().any(|c| c.id == m.conversation_id))?;
        found(
            s.inbox
                .messages
                .iter()
                .any(|r| r.workspace_id == ws && r.id == m.id),
        )?;
    }
    for o in &snap.outbox {
        found(snap.conversations.iter().any(|c| c.id == o.conversation_id))?;
        found(
            s.inbox
                .outbox
                .iter()
                .any(|r| r.workspace_id == ws && r.id == o.id),
        )?;
    }
    for t in &snap.tasks {
        found(
            s.inbox
                .journeys
                .iter()
                .any(|r| r.workspace_id == ws && r.id == t.journey_id),
        )?;
        found(
            s.inbox
                .tasks
                .iter()
                .any(|r| r.workspace_id == ws && r.id == t.id),
        )?;
    }
    for n in &snap.notes {
        found(
            s.inbox
                .journeys
                .iter()
                .any(|r| r.workspace_id == ws && r.id == n.journey_id),
        )?;
        found(
            s.inbox
                .notes
                .iter()
                .any(|r| r.workspace_id == ws && r.id == n.id),
        )?;
    }
    Ok(())
}

#[async_trait]
impl MergeRepo for MemTenant {
    async fn get(&mut self, id: MergeId) -> Result<Option<MergeRow>, AppError> {
        Ok(self
            .state()
            .inbox
            .merges
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn lock(&mut self, id: MergeId) -> Result<Option<MergeRow>, AppError> {
        MergeRepo::get(self, id).await
    }
    async fn list_all(&mut self) -> Result<Vec<MergeRow>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .merges
            .iter()
            .filter(|r| r.workspace_id == self.ws)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.at, r.id));
        Ok(rows)
    }
    async fn list(&mut self, person: PersonId) -> Result<Vec<MergeRow>, AppError> {
        Ok(MergeRepo::list_all(self)
            .await?
            .into_iter()
            .filter(|r| r.source_id == person || r.target_id == person)
            .collect())
    }
    async fn insert(&mut self, row: MergeRow) -> Result<(), AppError> {
        self.call(|t| {
            validate_row(t.state(), t.ws, &row)?;
            unique(
                !t.state().inbox.merges.iter().any(|r| r.id == row.id),
                "merge id is taken",
            )?;
            t.tx.write(move |s| s.inbox.merges.push(row.clone()));
            Ok(())
        })
    }
    async fn save(&mut self, row: MergeRow) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            validate_row(t.state(), ws, &row)?;
            found(
                t.state()
                    .inbox
                    .merges
                    .iter()
                    .any(|r| r.workspace_id == ws && r.id == row.id),
            )?;
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .merges
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == row.id)
                {
                    r.source_id = row.source_id;
                    r.target_id = row.target_id;
                    r.status = row.status.clone();
                    r.moved_snapshot = row.moved_snapshot.clone();
                    r.at = row.at;
                    r.applied_by = row.applied_by;
                }
            });
            Ok(())
        })
    }
    async fn mark_undone(&mut self, id: MergeId, at: OffsetDateTime) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            found(
                t.state()
                    .inbox
                    .merges
                    .iter()
                    .any(|r| r.workspace_id == ws && r.id == id),
            )?;
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .merges
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.status = "undone".into();
                    r.undone_at = Some(at);
                }
            });
            Ok(())
        })
    }
    async fn snapshot(&mut self, a: PersonId, b: PersonId) -> Result<MergeSnapshot, AppError> {
        self.call(|t| {
            person(t.state(), t.ws, a)?;
            person(t.state(), t.ws, b)?;
            let s = &t.state().inbox;
            let people = [a, b];
            let mut identities: Vec<_> = s
                .identities
                .iter()
                .filter(|r| r.workspace_id == t.ws && people.contains(&r.person_id))
                .map(|r| IdentityParent {
                    id: r.id,
                    person_id: r.person_id,
                    active: r.active,
                })
                .collect();
            identities.sort_by_key(|r| r.id);
            let mut journeys: Vec<_> = s
                .journeys
                .iter()
                .filter(|r| r.workspace_id == t.ws && people.contains(&r.person_id))
                .map(|r| JourneyParent {
                    id: r.id,
                    person_id: r.person_id,
                })
                .collect();
            journeys.sort_by_key(|r| r.id);
            let mut conversations: Vec<_> = s
                .conversations
                .iter()
                .filter(|r| r.workspace_id == t.ws && people.contains(&r.person_id))
                .cloned()
                .collect();
            conversations.sort_by_key(|r| r.id);
            let mut messages: Vec<_> = s
                .messages
                .iter()
                .filter(|r| {
                    r.workspace_id == t.ws
                        && conversations.iter().any(|c| c.id == r.conversation_id)
                })
                .collect();
            messages.sort_by_key(|r| (r.at, r.id));
            let messages = messages
                .into_iter()
                .map(|r| MessageParent {
                    id: r.id,
                    conversation_id: r.conversation_id,
                    external_id: r.external_id.clone(),
                })
                .collect();
            let mut tasks: Vec<_> = s
                .tasks
                .iter()
                .filter(|r| r.workspace_id == t.ws && journeys.iter().any(|j| j.id == r.journey_id))
                .map(|r| TaskParent {
                    id: r.id,
                    journey_id: r.journey_id,
                })
                .collect();
            tasks.sort_by_key(|r| r.id);
            let mut notes: Vec<_> = s
                .notes
                .iter()
                .filter(|r| r.workspace_id == t.ws && journeys.iter().any(|j| j.id == r.journey_id))
                .map(|r| NoteParent {
                    id: r.id,
                    journey_id: r.journey_id,
                })
                .collect();
            notes.sort_by_key(|r| r.id);
            let mut outbox: Vec<_> = s
                .outbox
                .iter()
                .filter(|r| {
                    r.workspace_id == t.ws
                        && conversations.iter().any(|c| c.id == r.conversation_id)
                })
                .map(|r| OutboxParent {
                    id: r.id,
                    conversation_id: r.conversation_id,
                })
                .collect();
            outbox.sort_by_key(|r| r.id);
            let latest_write_at = s
                .people
                .iter()
                .filter(|p| p.workspace_id == t.ws && people.contains(&p.id))
                .map(|p| p.updated_at)
                .chain(
                    s.journeys
                        .iter()
                        .filter(|j| j.workspace_id == t.ws && people.contains(&j.person_id))
                        .map(|j| j.updated_at),
                )
                .chain(conversations.iter().map(|c| c.updated_at))
                .max()
                .ok_or_else(|| AppError::not_found("no merge people"))?;
            Ok(MergeSnapshot {
                latest_write_at,
                people,
                version: 1,
                identities,
                journeys,
                conversations,
                messages,
                tasks,
                notes,
                outbox,
            })
        })
    }
    async fn edited_since(&mut self, id: PersonId, at: OffsetDateTime) -> Result<bool, AppError> {
        let s = &self.state().inbox;
        Ok(s.people
            .iter()
            .any(|r| r.workspace_id == self.ws && r.id == id && r.updated_at > at)
            || s.journeys
                .iter()
                .any(|r| r.workspace_id == self.ws && r.person_id == id && r.updated_at > at)
            || s.conversations
                .iter()
                .any(|r| r.workspace_id == self.ws && r.person_id == id && r.updated_at > at))
    }
    async fn apply_snapshot(
        &mut self,
        snapshot: &MergeSnapshot,
        keep: PersonId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            validate_snapshot(t.state(), ws, snapshot, false)?;
            person(t.state(), ws, keep)?;
            exists(
                snapshot.people.contains(&keep),
                "merge keeper belongs to snapshot",
            )?;
            unique(
                t.state()
                    .inbox
                    .journeys
                    .iter()
                    .filter(|r| {
                        r.workspace_id == ws
                            && snapshot.people.contains(&r.person_id)
                            && r.closed_at.is_none()
                    })
                    .count()
                    <= 1,
                "one open journey per person",
            )?;
            let snap = snapshot.clone();
            let targets = snap.conversation_targets();
            t.tx.write(move |s| {
                for r in s.inbox.identities.iter_mut().filter(|r| {
                    r.workspace_id == ws && snap.people.contains(&r.person_id) && r.active
                }) {
                    r.person_id = keep;
                }
                for r in s
                    .inbox
                    .journeys
                    .iter_mut()
                    .filter(|r| r.workspace_id == ws && snap.people.contains(&r.person_id))
                {
                    r.person_id = keep;
                    r.updated_at = at;
                }
                for r in
                    s.inbox.messages.iter_mut().filter(|r| {
                        r.workspace_id == ws && snap.messages.iter().any(|m| m.id == r.id)
                    })
                {
                    r.external_id = None;
                }
                for m in &snap.messages {
                    let target = targets[&m.conversation_id];
                    let collision = m.external_id.is_some()
                        && s.inbox.messages.iter().any(|r| {
                            r.workspace_id == ws
                                && r.conversation_id == target
                                && r.external_id == m.external_id
                        });
                    if let Some(r) = s
                        .inbox
                        .messages
                        .iter_mut()
                        .find(|r| r.workspace_id == ws && r.id == m.id)
                    {
                        r.conversation_id = target;
                        r.external_id = if collision {
                            None
                        } else {
                            m.external_id.clone()
                        };
                    }
                }
                for o in &snap.outbox {
                    if let Some(r) = s
                        .inbox
                        .outbox
                        .iter_mut()
                        .find(|r| r.workspace_id == ws && r.id == o.id)
                    {
                        r.conversation_id = targets[&o.conversation_id];
                    }
                }
                s.inbox.conversations.retain(|r| {
                    r.workspace_id != ws || targets.get(&r.id).is_none_or(|target| *target == r.id)
                });
                for r in s
                    .inbox
                    .conversations
                    .iter_mut()
                    .filter(|r| r.workspace_id == ws && snap.people.contains(&r.person_id))
                {
                    r.person_id = keep;
                    r.updated_at = at;
                }
                refresh_inbound_senders(s, ws, &snap, at);
                for r in s
                    .inbox
                    .people
                    .iter_mut()
                    .filter(|r| r.workspace_id == ws && snap.people.contains(&r.id))
                {
                    r.updated_at = at;
                }
            });
            Ok(())
        })
    }
    async fn restore_snapshot(
        &mut self,
        snapshot: &MergeSnapshot,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            validate_snapshot(t.state(), ws, snapshot, true)?;
            let snap = snapshot.clone();
            t.tx.write(move |s| {
                for c in &snap.conversations {
                    let mut restored = c.clone();
                    restored.updated_at = at;
                    if let Some(r) = s
                        .inbox
                        .conversations
                        .iter_mut()
                        .find(|r| r.workspace_id == ws && r.id == c.id)
                    {
                        *r = restored;
                    } else {
                        s.inbox.conversations.push(restored);
                    }
                }
                for m in &snap.messages {
                    if let Some(r) = s
                        .inbox
                        .messages
                        .iter_mut()
                        .find(|r| r.workspace_id == ws && r.id == m.id)
                    {
                        r.conversation_id = m.conversation_id;
                        r.external_id = m.external_id.clone();
                    }
                }
                for o in &snap.outbox {
                    if let Some(r) = s
                        .inbox
                        .outbox
                        .iter_mut()
                        .find(|r| r.workspace_id == ws && r.id == o.id)
                    {
                        r.conversation_id = o.conversation_id;
                    }
                }
                for i in &snap.identities {
                    if let Some(r) = s
                        .inbox
                        .identities
                        .iter_mut()
                        .find(|r| r.workspace_id == ws && r.id == i.id)
                    {
                        r.person_id = i.person_id;
                        r.active = i.active;
                    }
                }
                for j in &snap.journeys {
                    if let Some(r) = s
                        .inbox
                        .journeys
                        .iter_mut()
                        .find(|r| r.workspace_id == ws && r.id == j.id)
                    {
                        r.person_id = j.person_id;
                        r.updated_at = at;
                    }
                }
                for task in &snap.tasks {
                    if let Some(r) = s
                        .inbox
                        .tasks
                        .iter_mut()
                        .find(|r| r.workspace_id == ws && r.id == task.id)
                    {
                        r.journey_id = task.journey_id;
                    }
                }
                for note in &snap.notes {
                    if let Some(r) = s
                        .inbox
                        .notes
                        .iter_mut()
                        .find(|r| r.workspace_id == ws && r.id == note.id)
                    {
                        r.journey_id = note.journey_id;
                    }
                }
                refresh_inbound_senders(s, ws, &snap, at);
                for r in s
                    .inbox
                    .people
                    .iter_mut()
                    .filter(|r| r.workspace_id == ws && snap.people.contains(&r.id))
                {
                    r.updated_at = at;
                }
            });
            Ok(())
        })
    }
}

fn refresh_inbound_senders(
    s: &mut MemState,
    ws: WorkspaceId,
    snap: &MergeSnapshot,
    at: OffsetDateTime,
) {
    for c in s
        .inbox
        .conversations
        .iter_mut()
        .filter(|c| c.workspace_id == ws && snap.conversations.iter().any(|old| old.id == c.id))
    {
        let latest = s
            .inbox
            .messages
            .iter()
            .filter(|m| {
                m.workspace_id == ws
                    && m.conversation_id == c.id
                    && m.direction == Direction::Inbound
            })
            .max_by_key(|m| (m.at, m.id));
        let meta = s.inbox.conversation_send_states.entry(c.id).or_default();
        meta.activity_revision =
            (meta.activity_revision + 1).max((at.unix_timestamp_nanos() / 1_000).max(0) as i64);
        meta.last_inbound_identity_id = latest
            .filter(|m| c.last_inbound_at.is_none_or(|old| m.at >= old))
            .and_then(|m| s.inbox.message_senders.get(&m.id).copied());
        c.last_inbound_at = c.last_inbound_at.max(latest.map(|m| m.at));
    }
}
