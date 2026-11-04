//! The mandatory footer (spec §3.10, D12; its wording is for the owner's lawyer to confirm,
//! L-07): appended by Jeeta after every outreach body, never editable, in the template's
//! language. It names the sender, says why the recipient gets the email, links the privacy
//! notice and the unsubscribe link.

use jt_inbox::CommercialBasis;

use crate::{Lang, RenderError};

/// Why the recipient gets the email, which the footer's source line says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FooterSource {
    /// The business's publicly listed contact details (the business-recipient basis).
    PublicBusinessData,
    /// The recipient agreed to receive messages (an effective consent).
    Consent,
}

impl From<CommercialBasis> for FooterSource {
    /// The source line says what the send rests on: a consent, or the business's public data.
    fn from(basis: CommercialBasis) -> FooterSource {
        match basis {
            CommercialBasis::Consent => FooterSource::Consent,
            CommercialBasis::BusinessRecipient => FooterSource::PublicBusinessData,
        }
    }
}

/// `body` with the footer in `lang` after it, a blank line between: the text every commercial
/// email ends with (spec D62: the inbox's send pipeline appends it, whatever path the email
/// came from). [`RenderError::FooterIncomplete`] as [`Footer::render`].
pub fn append_footer(body: &str, footer: &Footer, lang: Lang) -> Result<String, RenderError> {
    Ok(format!("{}\n\n{}", body.trim_end(), footer.render(lang)?))
}

/// The footer's values: the workspace's sender identity and privacy notice, and this send's
/// unsubscribe link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Footer {
    pub sender_company: String,
    pub sender_address: String,
    pub privacy_notice_url: String,
    pub unsubscribe_url: String,
    pub source: FooterSource,
}

impl Footer {
    /// The footer's text in `lang`, without a leading blank line; [`RenderError::FooterIncomplete`]
    /// when a value is blank or holds a control character.
    pub fn render(&self, lang: Lang) -> Result<String, RenderError> {
        let values = [
            &self.sender_company,
            &self.sender_address,
            &self.privacy_notice_url,
            &self.unsubscribe_url,
        ];
        if values
            .iter()
            .any(|v| v.trim().is_empty() || v.chars().any(char::is_control))
        {
            return Err(RenderError::FooterIncomplete);
        }
        let (source, privacy, unsubscribe) = match (lang, self.source) {
            (Lang::Tr, FooterSource::PublicBusinessData) => (
                "Bu e-postayı işletmenizin herkese açık iletişim bilgileri üzerinden gönderiyoruz.",
                "Kişisel verilerin işlenmesi hakkında:",
                "Bu e-postaları almak istemiyorsanız:",
            ),
            (Lang::Tr, FooterSource::Consent) => (
                "Bu e-postayı bizden ileti almayı kabul ettiğiniz için alıyorsunuz.",
                "Kişisel verilerin işlenmesi hakkında:",
                "Bu e-postaları almak istemiyorsanız:",
            ),
            (Lang::En, FooterSource::PublicBusinessData) => (
                "We are sending this email to your business's publicly listed contact details.",
                "About the processing of personal data:",
                "To stop receiving these emails:",
            ),
            (Lang::En, FooterSource::Consent) => (
                "You are receiving this email because you agreed to receive messages from us.",
                "About the processing of personal data:",
                "To stop receiving these emails:",
            ),
        };
        Ok(format!(
            "--\n{} · {}\n{source}\n{privacy} {}\n{unsubscribe} {}",
            self.sender_company.trim(),
            self.sender_address.trim(),
            self.privacy_notice_url.trim(),
            self.unsubscribe_url.trim(),
        ))
    }
}
