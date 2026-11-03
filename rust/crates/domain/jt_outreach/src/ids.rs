//! Typed identifiers of outreach.

use jt_tenancy::define_id;

define_id!(
    /// A plain-text email template.
    TemplateId
);
define_id!(
    /// A campaign: one to six steps sent to a frozen audience.
    CampaignId
);
define_id!(
    /// One person's place in one campaign.
    EnrollmentId
);
define_id!(
    /// One outreach email: one step to one enrollment, through the outbox.
    SendId
);
