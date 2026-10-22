//! Budget items and their spend: the tenant's own money and the caps on its own accounts and
//! agents (spec §6.2 "Bütçe kalemi"; never the system's credit, K4).

use jt_tenancy::{WorkspaceId, define_id};
use serde::{Deserialize, Serialize};
use time::macros::datetime;
use time::{Date, Duration, Month, OffsetDateTime, UtcOffset};
use uuid::Uuid;

use crate::kind::{CapabilityKind, KindGroup};
use crate::{CapabilityError, check_len, checked_name, epoch};

define_id!(
    /// A budget item.
    BudgetItemId
);
define_id!(
    /// One recorded spend from a budget item.
    BudgetSpendId
);

/// The longest label of a [`Unit::Count`], in characters.
pub const MAX_UNIT_LABEL_CHARS: usize = 32;

/// The longest spend reference (an invoice number, a campaign id), in characters.
pub const MAX_REFERENCE_CHARS: usize = 256;

/// The end of the [`Period::Total`] window: later than any spend will ever be.
pub const END_OF_TIME: OffsetDateTime = datetime!(9999-12-31 23:59:59 UTC);

/// What a budget item holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetKind {
    /// Money the tenant lets the system spend.
    Cash,
    /// A cap on an ad account's spend.
    AdBudget,
    /// A cap on the SMS line's spend.
    SmsBudget,
    /// An agent's usage quota.
    AgentQuota,
    /// An agent's working hours.
    AgentHours,
    /// Supplies a device uses up (paper, filament).
    Consumable,
}

const ALL_BUDGET_KINDS: &[BudgetKind] = &[
    BudgetKind::Cash,
    BudgetKind::AdBudget,
    BudgetKind::SmsBudget,
    BudgetKind::AgentQuota,
    BudgetKind::AgentHours,
    BudgetKind::Consumable,
];

impl BudgetKind {
    /// The stable key, e.g. `"ad_budget"`.
    pub fn key(&self) -> &'static str {
        match self {
            BudgetKind::Cash => "cash",
            BudgetKind::AdBudget => "ad_budget",
            BudgetKind::SmsBudget => "sms_budget",
            BudgetKind::AgentQuota => "agent_quota",
            BudgetKind::AgentHours => "agent_hours",
            BudgetKind::Consumable => "consumable",
        }
    }

    /// The budget kind with this key, if any.
    pub fn parse(key: &str) -> Option<BudgetKind> {
        ALL_BUDGET_KINDS.iter().copied().find(|k| k.key() == key)
    }

    /// Every budget kind.
    pub fn all() -> &'static [BudgetKind] {
        ALL_BUDGET_KINDS
    }
}

/// What a budget item's cap and spend are counted in. Stored as
/// `{"kind": "currency", "value": "TRY"}`, `{"kind": "count", "value": "spools"}` or
/// `{"kind": "minutes"}`.
///
/// A missing unit reads as a count with an empty label, which [`validate_unit`] refuses, so it
/// shows as needing repair rather than passing as money.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Unit {
    /// Minor units of an ISO 4217 currency (kuruş for `TRY`).
    Currency(String),
    /// A count of things, named by a label of 1 to [`MAX_UNIT_LABEL_CHARS`] characters.
    Count(String),
    /// Minutes.
    Minutes,
}

impl Default for Unit {
    fn default() -> Self {
        Unit::Count(String::new())
    }
}

/// The period a cap applies to. Windows are UTC and half-open ([`period_window`]).
///
/// A missing period reads as `Total`: the same cap over all time allows the least spending.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Period {
    Daily,
    Weekly,
    Monthly,
    #[default]
    Total,
}

const ALL_PERIODS: &[Period] = &[
    Period::Daily,
    Period::Weekly,
    Period::Monthly,
    Period::Total,
];

impl Period {
    /// The stable key, e.g. `"monthly"`.
    pub fn key(&self) -> &'static str {
        match self {
            Period::Daily => "daily",
            Period::Weekly => "weekly",
            Period::Monthly => "monthly",
            Period::Total => "total",
        }
    }

    /// The period with this key, if any.
    pub fn parse(key: &str) -> Option<Period> {
        ALL_PERIODS.iter().copied().find(|p| p.key() == key)
    }

    /// Every period.
    pub fn all() -> &'static [Period] {
        ALL_PERIODS
    }
}

/// A budget item: a cap of one kind, in one unit, per period.
///
/// Stored, so reading is tolerant: an unknown field is ignored and every missing field but the
/// identity (`id`, `workspace_id`) and the `kind` reads as the default named on it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetItem {
    pub id: BudgetItemId,
    pub workspace_id: WorkspaceId,
    /// Missing reads as empty.
    #[serde(default)]
    pub name: String,
    pub kind: BudgetKind,
    /// Missing reads as [`Unit::default`].
    #[serde(default)]
    pub unit: Unit,
    /// The most that may be spent per period, in `unit`; not negative. Missing reads as 0, which
    /// allows nothing.
    #[serde(default)]
    pub cap: i64,
    /// Missing reads as `Total`.
    #[serde(default)]
    pub period: Period,
    /// The strategy version it came from. Missing reads as `None`.
    #[serde(default)]
    pub strategy_version_id: Option<Uuid>,
    /// Missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// What a new budget item is created with; [`BudgetItem::new`] checks it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewBudgetItem {
    pub name: String,
    pub kind: BudgetKind,
    pub unit: Unit,
    pub cap: i64,
    pub period: Period,
}

impl BudgetItem {
    /// A new budget item created at `now`, with no strategy version. Refuses a bad name (trimmed,
    /// then [`crate::validate_name`]), a bad unit ([`validate_unit`]) and a negative cap
    /// (`NegativeCap`).
    pub fn new(
        id: BudgetItemId,
        workspace_id: WorkspaceId,
        input: NewBudgetItem,
        now: OffsetDateTime,
    ) -> Result<BudgetItem, CapabilityError> {
        let NewBudgetItem {
            name,
            kind,
            unit,
            cap,
            period,
        } = input;
        let name = checked_name(name)?;
        validate_unit(&unit)?;
        if cap < 0 {
            return Err(CapabilityError::NegativeCap(cap));
        }
        Ok(BudgetItem {
            id,
            workspace_id,
            name,
            kind,
            unit,
            cap,
            period,
            strategy_version_id: None,
            created_at: now,
        })
    }
}

/// Who recorded a spend. Stored as `{"kind": "connector", "value": "meta_ads"}`,
/// `{"kind": "agent"}` or `{"kind": "human"}`.
///
/// A missing source reads as `Agent`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SpendSource {
    /// A connector, named by its capability kind key, reporting what its account spent.
    Connector(String),
    /// An agent reporting what it used.
    #[default]
    Agent,
    /// A person recording a spend in the panel.
    Human,
}

/// One spend from a budget item. Append-only.
///
/// Stored, so reading is tolerant: an unknown field is ignored and every missing field but the
/// ids reads as the default named on it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetSpend {
    pub id: BudgetSpendId,
    pub budget_item_id: BudgetItemId,
    pub workspace_id: WorkspaceId,
    /// Missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// In the item's unit; positive when written. Missing reads as 0.
    #[serde(default)]
    pub amount: i64,
    /// Missing reads as `Agent`.
    #[serde(default)]
    pub source: SpendSource,
    /// An invoice number, a campaign id, ... Missing reads as `None`.
    #[serde(default)]
    pub reference: Option<String>,
}

/// What a new spend is recorded with; [`BudgetSpend::new`] checks it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewBudgetSpend {
    pub amount: i64,
    pub source: SpendSource,
    pub reference: Option<String>,
}

impl BudgetSpend {
    /// A spend recorded at `at`. Refuses an amount that is not positive (`NonPositiveAmount`: a
    /// negative spend would raise what remains) and a reference over [`MAX_REFERENCE_CHARS`]
    /// characters. Spending over the cap is not refused here: it is recorded and shows as a
    /// negative [`remaining`].
    pub fn new(
        id: BudgetSpendId,
        workspace_id: WorkspaceId,
        budget_item_id: BudgetItemId,
        input: NewBudgetSpend,
        at: OffsetDateTime,
    ) -> Result<BudgetSpend, CapabilityError> {
        let NewBudgetSpend {
            amount,
            source,
            reference,
        } = input;
        if amount <= 0 {
            return Err(CapabilityError::NonPositiveAmount(amount));
        }
        if let Some(reference) = &reference {
            check_len("reference", reference, MAX_REFERENCE_CHARS)?;
        }
        Ok(BudgetSpend {
            id,
            budget_item_id,
            workspace_id,
            at,
            amount,
            source,
            reference,
        })
    }
}

/// `Ok` when `code` looks like an ISO 4217 code (three uppercase ASCII letters, e.g. `TRY`);
/// else `InvalidCurrency`. Whether the code is assigned is not checked.
pub fn validate_currency(code: &str) -> Result<(), CapabilityError> {
    if code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase()) {
        Ok(())
    } else {
        Err(CapabilityError::InvalidCurrency(code.to_owned()))
    }
}

/// `Ok` for minutes, a currency [`validate_currency`] accepts, or a count whose label is not
/// blank and has at most [`MAX_UNIT_LABEL_CHARS`] characters (else `InvalidUnitLabel`).
pub fn validate_unit(unit: &Unit) -> Result<(), CapabilityError> {
    match unit {
        Unit::Currency(code) => validate_currency(code),
        Unit::Count(label) => {
            if label.trim().is_empty() || label.chars().count() > MAX_UNIT_LABEL_CHARS {
                Err(CapabilityError::InvalidUnitLabel(label.clone()))
            } else {
                Ok(())
            }
        }
        Unit::Minutes => Ok(()),
    }
}

/// Whether a budget item of `kind` may be counted in `unit`: money (cash, ad and SMS budgets) in
/// a currency, consumables and agent quotas as a count, agent hours in minutes. Only the unit's
/// kind matters here; its currency code or label is [`validate_unit`]'s.
pub fn unit_fits(kind: BudgetKind, unit: &Unit) -> bool {
    use BudgetKind::*;
    match unit {
        Unit::Currency(_) => matches!(kind, Cash | AdBudget | SmsBudget),
        Unit::Count(_) => matches!(kind, Consumable | AgentQuota),
        Unit::Minutes => kind == AgentHours,
    }
}

/// Whether a capability of `kind` may spend from a budget item of `budget_kind`: ad accounts from
/// ad budgets or cash; the SMS line from the SMS budget or cash; agent connections from agent
/// quotas or agent hours (never cash); printers and 3D printers from consumables or cash; every
/// other kind from cash only.
pub fn can_link_budget(kind: &CapabilityKind, budget_kind: BudgetKind) -> bool {
    use BudgetKind::*;
    match (kind.group, kind.key) {
        (KindGroup::Ads, _) => matches!(budget_kind, AdBudget | Cash),
        (KindGroup::AgentConnection, _) => matches!(budget_kind, AgentQuota | AgentHours),
        (KindGroup::Messaging, "sms_line") => matches!(budget_kind, SmsBudget | Cash),
        (KindGroup::Device, "printer" | "printer_3d") => matches!(budget_kind, Consumable | Cash),
        _ => budget_kind == Cash,
    }
}

/// The window of `period` that holds `now`, as `[start, end)` in UTC (whatever the offset of
/// `now`): the UTC day; the week from Monday 00:00 UTC; the month from the 1st 00:00 UTC; for
/// `Total`, from the Unix epoch to [`END_OF_TIME`].
pub fn period_window(period: Period, now: OffsetDateTime) -> (OffsetDateTime, OffsetDateTime) {
    let today = now.to_offset(UtcOffset::UTC).date();
    let midnight = |d: Date| d.midnight().assume_utc();
    let (start, end) = match period {
        Period::Daily => (Some(today), today.next_day()),
        Period::Weekly => {
            let back = Duration::days(i64::from(today.weekday().number_days_from_monday()));
            let monday = today.checked_sub(back);
            (
                monday,
                monday.and_then(|m| m.checked_add(Duration::days(7))),
            )
        }
        Period::Monthly => {
            let (year, month) = (today.year(), today.month());
            let (next_year, next_month) = match month {
                Month::December => (year + 1, Month::January),
                _ => (year, month.next()),
            };
            (
                Date::from_calendar_date(year, month, 1).ok(),
                Date::from_calendar_date(next_year, next_month, 1).ok(),
            )
        }
        Period::Total => return (OffsetDateTime::UNIX_EPOCH, END_OF_TIME),
    };
    // Only dates at the very edge of the calendar fall back here.
    (
        start.map_or(OffsetDateTime::UNIX_EPOCH, midnight),
        end.map_or(END_OF_TIME, midnight),
    )
}

/// What is left of `cap` after `spent`: negative when over the cap, never overflowing.
pub fn remaining(cap: i64, spent: i64) -> i64 {
    cap.saturating_sub(spent)
}
