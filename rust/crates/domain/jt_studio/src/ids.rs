//! Tenant-owned typed identities, shared with application ports through re-exports.
use jt_tenancy::define_id;
define_id!(ArmId);
define_id!(SlotId);
define_id!(PieceId);
define_id!(FileId);
define_id!(PublicationId);
define_id!(PublishAttemptId);
define_id!(MeasurementId);
define_id!(TrendSignalId);
define_id!(AdSetBindingId);
define_id!(BudgetMoveId);
define_id!(ReservationId);
