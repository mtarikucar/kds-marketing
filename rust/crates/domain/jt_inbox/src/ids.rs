//! Typed identifiers shared by inbox records.

use jt_tenancy::define_id;

define_id!(
    /// A person within a workspace.
    PersonId
);
define_id!(
    /// One normalised contact identity of a person.
    IdentityId
);
define_id!(
    /// A person's conversation through one capability.
    ConversationId
);
define_id!(
    /// An inbound or outbound message.
    MessageId
);
define_id!(
    /// A person's acquisition journey.
    JourneyId
);
define_id!(
    /// An event recorded against a journey.
    JourneyEventId
);
define_id!(
    /// A task attached to a journey.
    TaskId
);
define_id!(
    /// A note attached to a journey.
    NoteId
);
define_id!(
    /// A recorded merge of two people.
    MergeId
);
define_id!(
    /// A decision in a person's consent history.
    ConsentId
);
define_id!(
    /// One public item: a comment or a marketplace question.
    PublicItemId
);
define_id!(
    /// The post or product a public item is about.
    PublicSubjectId
);
