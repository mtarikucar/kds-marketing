use jt_inbox::*;
use jt_tenancy::{UserId, WorkspaceId};
use time::OffsetDateTime;

#[test]
fn task_and_note_storage_round_trips_and_defaults() {
    let workspace_id = WorkspaceId::new_v7();
    let journey_id = JourneyId::new_v7();
    let user = UserId::new_v7();
    for status in [TaskStatus::Open, TaskStatus::Done, TaskStatus::Cancelled] {
        let task = Task {
            id: TaskId::new_v7(),
            workspace_id,
            journey_id,
            title: "Follow up".into(),
            due_at: OffsetDateTime::UNIX_EPOCH,
            assignee: Some(user),
            status,
        };
        let value = serde_json::to_value(&task).unwrap();
        assert_eq!(serde_json::from_value::<Task>(value.clone()).unwrap(), task);
        let mut old = value;
        old.as_object_mut().unwrap().remove("assignee");
        old.as_object_mut().unwrap().remove("status");
        old["future_field"] = serde_json::json!(true);
        let old: Task = serde_json::from_value(old).unwrap();
        assert_eq!(old.status, TaskStatus::Open);
        assert_eq!(old.assignee, None);
    }
    let note = Note {
        id: NoteId::new_v7(),
        workspace_id,
        journey_id,
        author: EventSource::Human(user),
        text: "Requested a follow-up call.".into(),
        at: OffsetDateTime::UNIX_EPOCH,
    };
    assert_eq!(
        serde_json::from_value::<Note>(serde_json::to_value(&note).unwrap()).unwrap(),
        note
    );
}
