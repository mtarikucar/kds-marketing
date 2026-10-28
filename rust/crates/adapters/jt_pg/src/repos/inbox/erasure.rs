use super::{map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{ErasureLog, ErasureRepo},
};
use jt_inbox::{IdentityChannel, PersonId};
#[async_trait]
impl ErasureRepo for PgTenantRepos {
    async fn scrub(&mut self, person: PersonId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let log = ErasureRepo::get(self, person)
            .await?
            .ok_or_else(|| AppError::conflict("erasure must be recorded before scrubbing"))?;
        let family: Vec<uuid::Uuid> = sqlx::query_scalar("with recursive family(id) as (select id from people where workspace_id=$1 and id=$2 union select p.id from people p join family f on p.merged_into=f.id where p.workspace_id=$1) select id from family order by id")
            .bind(ws.as_uuid()).bind(person.as_uuid()).fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"find erasure aliases"))?;
        for id in &family {
            let person = PersonId::from(*id);
            ErasureRepo::record(
                self,
                ErasureLog {
                    person_id: person,
                    ..log.clone()
                },
            )
            .await?;
            jt_app::ports::inbox::ConversationRepo::lock_for_person(self, person).await?;
        }
        // Include inactive identities and aliases; the normal public list returns only active keys.
        for id in &family {
            let person = PersonId::from(*id);
            let identities: Vec<serde_json::Value> = sqlx::query_scalar(
                "select to_jsonb(i) from identities i where workspace_id=$1 and person_id=$2",
            )
            .bind(ws.as_uuid())
            .bind(id)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "find all erasure identities"))?;
            for value in identities {
                let identity: jt_inbox::Identity = serde_json::from_value(value)?;
                ErasureRepo::remember_identity(
                    self,
                    identity.channel,
                    &jt_inbox::identity_hash(identity.channel, &identity.value_normalized),
                )
                .await?;
            }
            self.scrub_one(person).await?;
            jt_app::ports::inbox::PersonRepo::set_erased(self, person, log.at).await?;
        }
        // Inactive sender keys can remain on an alias while its messages live on the survivor.
        // Clear the entire family's references before deleting any of those keys.
        sqlx::query("delete from identities where workspace_id=$1 and person_id=any($2)")
            .bind(ws.as_uuid())
            .bind(&family)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "erase identity keys"))?;
        Ok(())
    }
    async fn record(&mut self, row: ErasureLog) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "people", row.person_id.as_uuid()).await?;
        sqlx::query("insert into erasure_log select * from jsonb_populate_record(null::erasure_log,$1) where workspace_id=$2 on conflict do nothing")
            .bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"record erasure"))?;
        Ok(())
    }
    async fn get(&mut self, person: PersonId) -> Result<Option<ErasureLog>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(e) from erasure_log e where workspace_id=$1 and person_id=$2"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(person.as_uuid()),
            self,
            ErasureLog
        )
    }
    async fn remember_identity(
        &mut self,
        channel: IdentityChannel,
        value_hash: &str,
    ) -> Result<(), AppError> {
        if value_hash.len() != 64
            || !value_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(AppError::validation(
                "invalid identity hash",
                serde_json::json!({}),
            ));
        }
        sqlx::query("insert into erased_identities(workspace_id,channel,value_hash) values ($1,$2,$3) on conflict do nothing")
            .bind(self.workspace_id().as_uuid()).bind(value!(channel).as_str()).bind(value_hash)
            .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"remember erased identity"))?;
        Ok(())
    }
    async fn is_erased_identity(
        &mut self,
        channel: IdentityChannel,
        value_hash: &str,
    ) -> Result<bool, AppError> {
        sqlx::query_scalar("select exists(select 1 from erased_identities where workspace_id=$1 and channel=$2 and value_hash=$3)")
            .bind(self.workspace_id().as_uuid()).bind(value!(channel).as_str()).bind(value_hash)
            .fetch_one(self.tx.conn()).await.map_err(|e|map_sqlx(e,"check erased identity"))
    }
}

impl PgTenantRepos {
    async fn scrub_one(&mut self, person: PersonId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        if ErasureRepo::get(self, person).await?.is_none() {
            return Err(AppError::conflict(
                "erasure must be recorded before scrubbing",
            ));
        }
        sqlx::query("select set_config('jeeta.erasure','on',true), set_config('jeeta.erasure_person_id',$1,true)")
            .bind(person.to_string()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"scope erasure"))?;
        // Raw is a complete delivery batch, often copied onto several parsed events. Purge every
        // copy in this tenant, but change parsed payloads ONLY for the matching person.
        sqlx::query("update inbound_events set raw=null where workspace_id=$1 and raw in (select raw from inbound_events where workspace_id=$1 and inbox_event_person(workspace_id,capability_id,payload,$2))")
            .bind(ws.as_uuid()).bind(person.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"erase raw batches"))?;
        for statement in [
            "update inbound_events set raw=null,payload=inbox_mask_personal(payload)||jsonb_build_object('person_id',$2::uuid::text) where workspace_id=$1 and inbox_event_person(workspace_id,capability_id,payload,$2)",
            "update probe_runs set facts=jsonb_build_object('person_id',$2::uuid::text) where workspace_id=$1 and facts->>'person_id'=$2::uuid::text",
            "update journey_events set payload=inbox_mask_personal(payload),reason_label=null where workspace_id=$1 and journey_id in (select id from journeys where workspace_id=$1 and person_id=$2)",
            "update journeys set lost_reason=case when lost_reason is null then null else jsonb_build_object('reason_key',lost_reason->'reason_key','reason_label','') end where workspace_id=$1 and person_id=$2",
            "update tasks set title='' where workspace_id=$1 and journey_id in (select id from journeys where workspace_id=$1 and person_id=$2)",
            "update notes set text='' where workspace_id=$1 and journey_id in (select id from journeys where workspace_id=$1 and person_id=$2)",
            "update quotes set file_ref=null where workspace_id=$1 and journey_id in (select id from journeys where workspace_id=$1 and person_id=$2)",
            "update appointments set location='' where workspace_id=$1 and journey_id in (select id from journeys where workspace_id=$1 and person_id=$2)",
            "update outbox set intent=case when intent#>>'{mail,message_id}' is null then '{}'::jsonb else jsonb_build_object('mail',jsonb_build_object('message_id',intent#>>'{mail,message_id}')) end,fence_snapshot=null,last_error=null,state=case when state='queued' then 'refused' else state end where workspace_id=$1 and conversation_id in (select id from conversations where workspace_id=$1 and person_id=$2)",
            "update outbound_jobs set last_status=null,state='erased' where workspace_id=$1 and message_id in (select m.id from messages m join conversations c on c.id=m.conversation_id and c.workspace_id=m.workspace_id where m.workspace_id=$1 and c.person_id=$2)",
            "update messages set body='',sender_identity_id=null,status=case when jsonb_typeof(status)='object' then inbox_mask_personal(status) else status end where workspace_id=$1 and conversation_id in (select id from conversations where workspace_id=$1 and person_id=$2)",
            "update conversations set last_inbound_identity_id=null,executor_generation=executor_generation+1 where workspace_id=$1 and person_id=$2",
            "update merges set moved_snapshot='{}',conflicts='[]',decision='{\"suggest\":[]}' where workspace_id=$1 and (source_id=$2 or target_id=$2)",
            // Responses are nested (quote/reply/send); ids scope cache deletion without touching other people.
            "delete from request_keys where workspace_id=$1 and (response->>'person_id'=$2::uuid::text or exists (select 1 from conversations c where c.workspace_id=$1 and c.person_id=$2 and (response->>'conversation_id'=c.id::text or response#>>'{reply,conversation_id}'=c.id::text)) or exists (select 1 from journeys j where j.workspace_id=$1 and j.person_id=$2 and (response#>>'{quote,journey_id}'=j.id::text or response->>'journey_id'=j.id::text)))",
            // Calls keep their times, states and turn numbers; the number, the plan (its
            // sentences name the person), the summary, the recording reference and every turn's
            // words go, and so do the voice bridge's commands of those calls (a dial carries the
            // number, a sentence its words) and the notes of the events it reported on them.
            "update call_turns set text='' where workspace_id=$1 and call_id in (select id from call_sessions where workspace_id=$1 and person_id=$2)",
            "delete from call_commands where workspace_id=$1 and call_id in (select id from call_sessions where workspace_id=$1 and person_id=$2)",
            "delete from call_bridge_events where workspace_id=$1 and bridge_call_id in (select bridge_call_id from call_sessions where workspace_id=$1 and person_id=$2 and bridge_call_id is not null)",
            "update call_sessions set counterpart_e164='',data=jsonb_set(jsonb_set(jsonb_set(jsonb_set(data,'{counterpart_e164}','\"\"'),'{summary}','null'),'{plan}','null'),'{recording}','{\"state\":\"off\"}') where workspace_id=$1 and person_id=$2",
            "update people set display_name='silinmiş kişi',company='' where workspace_id=$1 and id=$2",
        ] {
            sqlx::query(statement)
                .bind(ws.as_uuid())
                .bind(person.as_uuid())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "scrub person inventory"))?;
        }
        Ok(())
    }
}
