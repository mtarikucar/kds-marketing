//! Internal appointments and deterministic RFC 5545 calendar attachments. No calendar I/O.

use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, UtcOffset};

use crate::JourneyId;

/// Lifecycle of an internal appointment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppointmentState {
    /// Scheduled, not yet held.
    Booked,
    /// Meeting took place.
    Held,
    /// Booking was cancelled.
    Cancelled,
}

/// An appointment belongs to a journey; it does not imply external-calendar availability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Appointment {
    /// Journey receiving the appointment.
    pub journey_id: JourneyId,
    /// Inclusive start instant.
    #[serde(with = "time::serde::rfc3339")]
    pub starts_at: OffsetDateTime,
    /// Exclusive end instant, strictly after the start.
    #[serde(with = "time::serde::rfc3339")]
    pub ends_at: OffsetDateTime,
    /// Free-form meeting location.
    pub location: String,
    /// Current lifecycle state.
    pub state: AppointmentState,
}

/// Rejected appointment input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AppointmentError {
    /// End must be strictly after start.
    #[error("appointment end must be after start")]
    InvalidInterval,
    /// iCalendar requires a four-digit UTC year.
    #[error("appointment date is outside the iCalendar range")]
    InvalidDate,
}

impl Appointment {
    /// Validate the interval before recording or exporting it.
    pub fn validate(&self) -> Result<(), AppointmentError> {
        if self.ends_at <= self.starts_at {
            return Err(AppointmentError::InvalidInterval);
        }
        for at in [self.starts_at, self.ends_at] {
            if !(0..=9999).contains(&at.to_offset(UtcOffset::UTC).year()) {
                return Err(AppointmentError::InvalidDate);
            }
        }
        Ok(())
    }
}

/// Produce a VCALENDAR 2.0 attachment with UTC instants, escaped TEXT and 75-octet folds.
/// Addresses are validated mailbox addresses supplied by the application; UID is stable per
/// appointment. The pure export uses the start as its deterministic DTSTAMP because this
/// domain snapshot carries no creation clock. Persist the attachment with the outbound job.
///
/// # Panics
/// Panics for an invalid appointment; callers must validate input before persisting it.
pub fn ics(
    appointment: &Appointment,
    organizer_email: &str,
    attendee_email: &str,
    uid: &str,
) -> String {
    appointment.validate().expect("invalid appointment for ICS");
    let status = match appointment.state {
        AppointmentState::Booked | AppointmentState::Held => "CONFIRMED",
        AppointmentState::Cancelled => "CANCELLED",
    };
    let lines = [
        "BEGIN:VCALENDAR".into(),
        "VERSION:2.0".into(),
        "PRODID:-//Jeeta//Inbox//EN".into(),
        "BEGIN:VEVENT".into(),
        format!("UID:{}", escape_text(uid)),
        format!("DTSTAMP:{}", utc(appointment.starts_at)),
        format!("DTSTART:{}", utc(appointment.starts_at)),
        format!("DTEND:{}", utc(appointment.ends_at)),
        format!("ORGANIZER:mailto:{}", mailto(organizer_email)),
        format!("ATTENDEE:mailto:{}", mailto(attendee_email)),
        format!("LOCATION:{}", escape_text(&appointment.location)),
        format!("STATUS:{status}"),
        "END:VEVENT".into(),
        "END:VCALENDAR".into(),
    ];
    let mut calendar = String::new();
    for line in lines {
        fold_line(&mut calendar, &line);
    }
    calendar
}

fn utc(at: OffsetDateTime) -> String {
    let at = at.to_offset(UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        at.year(),
        at.month() as u8,
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

fn escape_text(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace("\r\n", "\n")
        .replace(['\r', '\n'], "\\n")
}

// CAL-ADDRESS is a URI, not TEXT: percent-encode anything outside the mailbox-safe URI set.
// In particular raw CR/LF can never introduce another content line.
fn mailto(email: &str) -> String {
    let mut encoded = String::new();
    for byte in email.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~@!$'()*+,;=:".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

fn fold_line(output: &mut String, line: &str) {
    let mut octets = 0;
    for c in line.chars() {
        if octets + c.len_utf8() > 75 {
            output.push_str("\r\n ");
            octets = 1; // Continuation whitespace counts toward the physical line limit.
        }
        output.push(c);
        octets += c.len_utf8();
    }
    output.push_str("\r\n");
}
