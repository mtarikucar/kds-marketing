//! The order an automatic reply creates in the workspace's own shop for a quote the customer
//! accepted (`usecases::inbox::autoreply`, migration `0050_auto_reply_orders`). Pure: no I/O, no
//! clock.
//!
//! - **The template** ([`OrderTemplate`]) is the shop's request, as its owner set it
//!   (`connector.set_shop_order`): the tool to call, its arguments with placeholders, and where
//!   the tool's result holds the payment link, the shop's reference and the amount. A JSON string
//!   that is exactly `"{{var}}"` becomes the typed value ([`render`]); `"{{var?}}"` drops its key
//!   (or array item) when the value is empty. There is no interpolation inside a longer string.
//!   The variables are a closed list ([`VARIABLES`]); `ref` and an amount must appear.
//! - **The details** the model collected ([`OrderFields`]) are checked here ([`check`]): each
//!   within its length; every word of the name and the address one the customer wrote in this
//!   journey; the email a whole address the customer wrote, a given phone a whole number the
//!   customer wrote; the item naming no money and no link. They exist in memory only, between the
//!   model's answer and the shop's call: `Debug` masks every one of them.
//! - **The confirmation**: before the shop is asked, the customer is shown a fixed summary
//!   ([`summary`]) and must answer it with an explicit yes ([`explicit_yes`]); the details are
//!   compared across the two steps by their canonical form ([`canonical`]).
//! - **The answer** ([`read_result`]): an `isError` result, or one whose `ok` is not `true`, is a
//!   refusal; otherwise the link (a bare `https` URL, at most [`MAX_URL_CHARS`]), the amount (always
//!   mapped) and the reference when mapped ([`clean_reference`] says what may be shown of it).

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::autoreply::{links_allowed, normalise as normalise_text, scan};
use crate::{IdentityChannel, normalise as normalise_identity};

/// The variables a template may name.
pub const VARIABLES: &[&str] = &[
    "ref",
    "amount",
    "amount_minor",
    "currency",
    "name",
    "email",
    "phone",
    "street",
    "neighbourhood",
    "district",
    "province",
    "postcode",
    "payment_method",
    "item",
];

/// The largest template, in bytes of its JSON.
pub const MAX_TEMPLATE_BYTES: usize = 8 * 1024;
/// The deepest nesting of a template's arguments.
pub const MAX_DEPTH: usize = 8;
/// The longest tool name.
pub const MAX_TOOL_CHARS: usize = 100;
/// The payment methods the model may name.
pub const PAYMENT_METHODS: &[&str] = &["card", "bank_transfer"];

/// Where the tool's result holds what the server reads, as JSON pointers into the result's JSON
/// (`content[0].text` read as JSON when `text_json`, else `structuredContent`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultMap {
    #[serde(default)]
    pub text_json: bool,
    /// A boolean that must be `true`.
    #[serde(default)]
    pub ok: Option<String>,
    /// The payment link (required).
    pub url: String,
    /// The shop's reference of the order.
    #[serde(default)]
    pub reference: Option<String>,
    /// The order's amount in minor units, which must equal the quote's.
    #[serde(default)]
    pub amount_minor: Option<String>,
}

/// A shop's order template (`connector_public.order`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderTemplate {
    pub enabled: bool,
    pub tool: String,
    /// The ISO 4217 code of the shop's prices: a quote in another currency is never ordered.
    pub currency: String,
    pub arguments: Value,
    pub result: ResultMap,
}

/// Why a template was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TemplateError {
    /// Not an object of the template's fields (an unknown or missing field, a wrong type).
    Shape,
    TooLarge,
    TooDeep,
    /// The tool's name is empty, too long or holds a control character.
    Tool,
    /// The currency is not three upper-case letters.
    Currency,
    /// A placeholder names an unknown variable, or a string holds `{{` without being one.
    Placeholder(String),
    /// `ref` does not appear.
    NoRef,
    /// Neither `amount` nor `amount_minor` appears.
    NoAmount,
    /// The result maps no amount (`result.amount_minor`): the shop's amount is always checked.
    NoResultAmount,
    /// A result pointer is not a JSON pointer (`/a/b`).
    Pointer(&'static str),
}

impl TemplateError {
    /// The stable code, e.g. `"placeholder"`.
    pub fn key(&self) -> &'static str {
        match self {
            TemplateError::Shape => "shape",
            TemplateError::TooLarge => "too_large",
            TemplateError::TooDeep => "too_deep",
            TemplateError::Tool => "tool",
            TemplateError::Currency => "currency",
            TemplateError::Placeholder(_) => "placeholder",
            TemplateError::NoRef => "no_ref",
            TemplateError::NoAmount => "no_amount",
            TemplateError::NoResultAmount => "no_result_amount",
            TemplateError::Pointer(_) => "pointer",
        }
    }
}

impl fmt::Display for TemplateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TemplateError::Shape => f.write_str(
                "the template is an object of enabled, tool, currency, arguments and result",
            ),
            TemplateError::TooLarge => write!(f, "the template is over {MAX_TEMPLATE_BYTES} bytes"),
            TemplateError::TooDeep => write!(f, "the arguments nest deeper than {MAX_DEPTH}"),
            TemplateError::Tool => write!(f, "tool must be 1 to {MAX_TOOL_CHARS} characters"),
            TemplateError::Currency => f.write_str("currency must be an ISO 4217 code"),
            TemplateError::Placeholder(p) => write!(
                f,
                "unknown placeholder {p:?}: a string is exactly \"{{{{var}}}}\" or \"{{{{var?}}}}\" \
                 of {}",
                VARIABLES.join(", ")
            ),
            TemplateError::NoRef => f.write_str("the arguments must hold {{ref}}"),
            TemplateError::NoResultAmount => f.write_str(
                "result.amount_minor must name where the shop's answer holds the order's amount in \
                 minor units",
            ),
            TemplateError::NoAmount => {
                f.write_str("the arguments must hold {{amount}} or {{amount_minor}}")
            }
            TemplateError::Pointer(which) => write!(f, "result.{which} is not a JSON pointer"),
        }
    }
}

/// A string's placeholder: its variable and whether it is optional; `None` for a plain string.
/// `Err` for a string that holds `{{` but is not exactly a placeholder.
fn placeholder(s: &str) -> Result<Option<(&str, bool)>, TemplateError> {
    if !s.contains("{{") && !s.contains("}}") {
        return Ok(None);
    }
    let inner = s
        .strip_prefix("{{")
        .and_then(|r| r.strip_suffix("}}"))
        .ok_or_else(|| TemplateError::Placeholder(s.to_owned()))?;
    let (var, optional) = match inner.strip_suffix('?') {
        Some(v) => (v, true),
        None => (inner, false),
    };
    if !VARIABLES.contains(&var) {
        return Err(TemplateError::Placeholder(s.to_owned()));
    }
    Ok(Some((var, optional)))
}

/// Every placeholder of `value` (checked), and its depth.
fn walk(value: &Value, depth: usize, found: &mut Vec<String>) -> Result<(), TemplateError> {
    if depth > MAX_DEPTH {
        return Err(TemplateError::TooDeep);
    }
    match value {
        Value::String(s) => {
            if let Some((var, _)) = placeholder(s)? {
                found.push(var.to_owned());
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, depth + 1, found)?;
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                placeholder(key)?
                    .map_or(Ok(()), |_| Err(TemplateError::Placeholder(key.clone())))?;
                walk(item, depth + 1, found)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn pointer_ok(p: &str) -> bool {
    p.is_empty() || (p.starts_with('/') && !p.chars().any(char::is_control))
}

impl OrderTemplate {
    /// `value` as a template, every rule checked (see the module docs).
    pub fn parse(value: &Value) -> Result<OrderTemplate, TemplateError> {
        if serde_json::to_vec(value).map_or(usize::MAX, |b| b.len()) > MAX_TEMPLATE_BYTES {
            return Err(TemplateError::TooLarge);
        }
        let t: OrderTemplate =
            serde_json::from_value(value.clone()).map_err(|_| TemplateError::Shape)?;
        let n = t.tool.chars().count();
        if n == 0 || n > MAX_TOOL_CHARS || t.tool.chars().any(char::is_control) {
            return Err(TemplateError::Tool);
        }
        if t.currency.len() != 3 || !t.currency.chars().all(|c| c.is_ascii_uppercase()) {
            return Err(TemplateError::Currency);
        }
        let mut found = Vec::new();
        walk(&t.arguments, 1, &mut found)?;
        if !found.iter().any(|v| v == "ref") {
            return Err(TemplateError::NoRef);
        }
        if !found.iter().any(|v| v == "amount" || v == "amount_minor") {
            return Err(TemplateError::NoAmount);
        }
        let r = &t.result;
        if r.amount_minor.is_none() {
            return Err(TemplateError::NoResultAmount);
        }
        if !pointer_ok(&r.url) || r.url.is_empty() {
            return Err(TemplateError::Pointer("url"));
        }
        for (which, p) in [
            ("ok", &r.ok),
            ("reference", &r.reference),
            ("amount_minor", &r.amount_minor),
        ] {
            if p.as_deref().is_some_and(|p| !pointer_ok(p)) {
                return Err(TemplateError::Pointer(which));
            }
        }
        Ok(t)
    }

    /// The stored template of `public` (a capability's `connector_public`), when it holds a valid
    /// one.
    pub fn of_public(public: &Value) -> Option<OrderTemplate> {
        public
            .get("order")
            .and_then(|v| OrderTemplate::parse(v).ok())
    }
}

/// The details of an order, as the model collected them (empty for none). Held in memory only:
/// `Debug` masks every field.
#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
pub struct OrderFields {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub street: String,
    #[serde(default)]
    pub neighbourhood: String,
    #[serde(default)]
    pub district: String,
    #[serde(default)]
    pub province: String,
    #[serde(default)]
    pub postcode: String,
    #[serde(default)]
    pub payment_method: String,
    #[serde(default)]
    pub item: String,
}

impl fmt::Debug for OrderFields {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OrderFields(***)")
    }
}

/// A detail that is missing or malformed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Field {
    Name,
    Email,
    Phone,
    Street,
    Neighbourhood,
    District,
    Province,
    Postcode,
    PaymentMethod,
    Item,
}

impl Field {
    /// The stable code, e.g. `"email"`.
    pub fn key(self) -> &'static str {
        match self {
            Field::Name => "name",
            Field::Email => "email",
            Field::Phone => "phone",
            Field::Street => "street",
            Field::Neighbourhood => "neighbourhood",
            Field::District => "district",
            Field::Province => "province",
            Field::Postcode => "postcode",
            Field::PaymentMethod => "payment_method",
            Field::Item => "item",
        }
    }

    /// How the customer is asked for it (Turkish).
    pub fn ask(self) -> &'static str {
        match self {
            Field::Name => "adınız ve soyadınız",
            Field::Email => "e-posta adresiniz",
            Field::Phone => "telefon numaranız",
            Field::Street => "açık adresiniz (mahalle, sokak, bina ve daire)",
            Field::Neighbourhood => "mahalleniz",
            Field::District => "ilçe",
            Field::Province => "il",
            Field::Postcode => "posta kodu",
            Field::PaymentMethod => "ödeme şekli (kart ya da havale)",
            Field::Item => "siparişin kısa açıklaması",
        }
    }
}

/// The fixed message that asks for `missing` (never empty: the caller asks only when something
/// is).
pub fn ask(missing: &[Field]) -> String {
    let named: Vec<&str> = missing.iter().map(|f| f.ask()).collect();
    format!(
        "Siparişi oluşturmak için şunlar eksik ya da net değil: {}. Yazar mısınız?",
        named.join(", ")
    )
}

/// Order details that passed [`check`]: trimmed, the phone resolved. Held in memory only.
#[derive(Clone, PartialEq, Eq)]
pub struct CheckedOrder {
    pub name: String,
    pub email: String,
    pub phone: String,
    pub street: String,
    pub neighbourhood: String,
    pub district: String,
    pub province: String,
    pub postcode: String,
    pub payment_method: String,
    pub item: String,
}

impl fmt::Debug for CheckedOrder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CheckedOrder(***)")
    }
}

/// Whether `text` holds at least `n` letters.
fn letters(text: &str, n: usize) -> bool {
    text.chars().filter(|c| c.is_alphabetic()).count() >= n
}

fn within(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.chars().count())
}

/// The words of `text` as they are compared: normalised (Turkish lower case, NFKC), split at
/// every character that is not a letter or a digit.
fn tokens(text: &str) -> Vec<String> {
    normalise_text(text)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Whether every word of `field` is a whole word of `said`.
fn words_said(field: &str, said: &std::collections::HashSet<String>) -> bool {
    tokens(field).iter().all(|t| said.contains(t))
}

/// The email-shaped tokens of `text`: whitespace-separated, surrounding punctuation trimmed,
/// lower case.
fn emails_in(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|t| t.trim_matches(|c: char| "()[]{}<>\"'.,;:!?«»“”‘’".contains(c)))
        .filter(|t| t.contains('@'))
        .filter_map(|t| normalise_identity(IdentityChannel::Email, t).ok())
        .collect()
}

/// Every phone number of `text`, normalised (`+90…`): each run of digits and separators
/// (`+ ( ) - .` and spaces), and every contiguous group of its digit groups, that normalises to a
/// number of 10 to 15 digits.
fn phones_in(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut run = String::new();
    let mut flush = |run: &mut String| {
        let groups: Vec<&str> = run
            .split(|c: char| !(c.is_ascii_digit() || c == '+'))
            .filter(|g| !g.is_empty())
            .collect();
        for i in 0..groups.len() {
            for j in i + 1..=groups.len() {
                let joined = groups[i..j].concat();
                let n = joined.chars().filter(char::is_ascii_digit).count();
                if (10..=15).contains(&n)
                    && let Ok(p) = normalise_identity(IdentityChannel::Phone, &joined)
                {
                    out.push(p);
                }
            }
        }
        run.clear();
    };
    for c in text.chars() {
        if c.is_ascii_digit() || "+()-. ".contains(c) {
            run.push(c);
        } else {
            flush(&mut run);
        }
    }
    flush(&mut run);
    out
}

/// `fields` checked against what the customer wrote in this journey (`customer`, their messages'
/// texts) and the conversation's own number (`own_phone`, used when no other phone is given);
/// `Err` with every detail missing, malformed or not the customer's own, in a stable order. Every
/// word of the name, the street, the neighbourhood, the district, the province and the postcode
/// must be a whole word the customer wrote; the email must be a whole address the customer wrote
/// (case aside); a given phone a whole number the customer wrote (country and trunk prefixes
/// aside). `year` is the calendar year the item's money rules read in.
pub fn check(
    fields: &OrderFields,
    customer: &[&str],
    own_phone: Option<&str>,
    year: i32,
) -> Result<CheckedOrder, Vec<Field>> {
    // Trimmed, whitespace collapsed, nothing else changed: the exact text the summary shows and
    // the shop receives.
    let t = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut bad = Vec::new();
    let said: std::collections::HashSet<String> = customer.iter().flat_map(|m| tokens(m)).collect();
    let emails: Vec<String> = customer.iter().flat_map(|m| emails_in(m)).collect();
    let phones: Vec<String> = customer.iter().flat_map(|m| phones_in(m)).collect();
    let own =
        |text: &str, min: usize, max: usize| within(text, min, max) && words_said(text, &said);

    let name = t(&fields.name);
    if !own(&name, 1, 120) || !letters(&name, 2) {
        bad.push(Field::Name);
    }
    let email = match normalise_identity(IdentityChannel::Email, &fields.email) {
        Ok(e) if e.len() <= 254 && emails.contains(&e) => e,
        _ => {
            bad.push(Field::Email);
            String::new()
        }
    };
    let given = t(&fields.phone);
    let phone = if given.is_empty() {
        match own_phone {
            Some(own) => own.to_owned(),
            None => {
                bad.push(Field::Phone);
                String::new()
            }
        }
    } else {
        let only = given
            .chars()
            .all(|c| c.is_ascii_digit() || "+()-. ".contains(c));
        match normalise_identity(IdentityChannel::Phone, &given) {
            Ok(p) if only && phones.contains(&p) => p,
            _ => {
                bad.push(Field::Phone);
                String::new()
            }
        }
    };
    let street = t(&fields.street);
    if !own(&street, 1, 300) {
        bad.push(Field::Street);
    }
    let neighbourhood = t(&fields.neighbourhood);
    if !own(&neighbourhood, 0, 120) {
        bad.push(Field::Neighbourhood);
    }
    let district = t(&fields.district);
    if !own(&district, 1, 120) {
        bad.push(Field::District);
    }
    let province = t(&fields.province);
    if !own(&province, 1, 120) {
        bad.push(Field::Province);
    }
    let postcode = t(&fields.postcode);
    if !own(&postcode, 0, 20) {
        bad.push(Field::Postcode);
    }
    let payment_method = t(&fields.payment_method);
    if !PAYMENT_METHODS.contains(&payment_method.as_str()) {
        bad.push(Field::PaymentMethod);
    }
    let item = t(&fields.item);
    let s = scan(&item, year);
    if !within(&item, 1, 120)
        || !s.amounts.is_empty()
        || !s.terms.is_empty()
        || !s.currency.is_empty()
        || !links_allowed(&item, "")
    {
        bad.push(Field::Item);
    }
    if !bad.is_empty() {
        return Err(bad);
    }
    Ok(CheckedOrder {
        name,
        email,
        phone,
        street,
        neighbourhood,
        district,
        province,
        postcode,
        payment_method,
        item,
    })
}

/// The whole messages that say yes to the summary, as [`explicit_yes`] reads a message.
pub const YES_MESSAGES: &[&str] = &[
    "evet",
    "evet doğru",
    "evet onaylıyorum",
    "evet onay",
    "onaylıyorum",
    "onay veriyorum",
    "kabul ediyorum",
    "evet kabul ediyorum",
    "doğru",
    "doğrudur",
    "evet tamam",
    "tamam",
    "tamamdır",
    "olur",
    "evet olur",
    "evet lütfen",
    "yes",
    "yes please",
    "ok",
    "okay",
    "okey",
];

/// Whether `c` is decoration around a message: an emoji, a variation selector, a skin tone or a
/// joiner.
fn decoration(c: char) -> bool {
    let cp = c as u32;
    matches!(cp, 0x200D | 0xFE0E | 0xFE0F | 0x20E3)
        || (0x1F000..=0x1FAFF).contains(&cp)
        || (0x2600..=0x27BF).contains(&cp)
        || (0x1F3FB..=0x1F3FF).contains(&cp)
}

/// Whether `text` (a customer's message after the summary) is an explicit yes: the whole message,
/// in Turkish lower case with only the surrounding whitespace and emoji and the trailing `.`, `!`
/// and `,` taken off (whitespace inside collapsed), is one of [`YES_MESSAGES`]. A message with a
/// `?` anywhere is never a yes, and nothing else is. Decided by the server alone.
pub fn explicit_yes(text: &str) -> bool {
    if text.contains('?') || text.contains('？') {
        return false;
    }
    let lower = normalise_text(text);
    let mut core = lower.trim_matches(|c: char| c.is_whitespace() || decoration(c));
    loop {
        let next = core
            .trim_end_matches(['.', '!', ','])
            .trim_matches(|c: char| c.is_whitespace() || decoration(c));
        if next == core {
            break;
        }
        core = next;
    }
    let core = core.split_whitespace().collect::<Vec<_>>().join(" ");
    YES_MESSAGES.contains(&core.as_str())
}

/// `minor` as whole units with `.` between thousands (`3.500`, `3.500,50`).
fn money(minor: i64) -> String {
    let whole = (minor / 100).to_string();
    let mut out = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(c);
    }
    if minor % 100 != 0 {
        out.push_str(&format!(",{:02}", (minor % 100).abs()));
    }
    out
}

/// The line that asks the customer to confirm the summary.
pub const CONFIRM_LINE: &str = "Bilgiler doğruysa siparişi onaylamak için “Evet” yazın.";

/// The fixed summary the customer confirms before the order is created: their details, the item
/// and its quantity, the payment method in words and the amount, then [`CONFIRM_LINE`]. Built
/// from the same strings the shop receives.
pub fn summary(order: &CheckedOrder, quantity: i64, amount_minor: i64, currency: &str) -> String {
    let mut address: Vec<&str> = vec![order.street.as_str()];
    if !order.neighbourhood.is_empty() {
        address.push(&order.neighbourhood);
    }
    let place = format!("{} / {}", order.district, order.province);
    address.push(&place);
    if !order.postcode.is_empty() {
        address.push(&order.postcode);
    }
    let payment = match order.payment_method.as_str() {
        "bank_transfer" => "Havale / EFT",
        _ => "Kart",
    };
    [
        "Siparişinizi oluşturmadan önce bilgilerinizi kontrol eder misiniz?".to_owned(),
        format!("Ad soyad: {}", order.name),
        format!("E-posta: {}", order.email),
        format!("Telefon: {}", order.phone),
        format!("Adres: {}", address.join(", ")),
        format!("Ürün: {} x{quantity}", order.item),
        format!("Ödeme: {payment}"),
        format!("Tutar: {} {currency}", money(amount_minor)),
        String::new(),
        CONFIRM_LINE.to_owned(),
    ]
    .join("\n")
}

/// The quantity the rendered arguments `arguments` order: the first integer under a key named
/// `quantity` (at any depth), else 1.
pub fn quantity_of(arguments: &Value) -> i64 {
    fn find(v: &Value) -> Option<i64> {
        match v {
            Value::Object(map) => map
                .get("quantity")
                .and_then(Value::as_i64)
                .or_else(|| map.values().find_map(find)),
            Value::Array(items) => items.iter().find_map(find),
            _ => None,
        }
    }
    find(arguments).unwrap_or(1)
}

/// The longest shop reference that is kept and shown.
pub const MAX_REFERENCE_CHARS: usize = 40;

/// The shop's reference as it may be kept and shown to the model: letters, digits, `-` and `_`,
/// at most [`MAX_REFERENCE_CHARS`]; anything else is none.
pub fn clean_reference(reference: Option<&str>) -> Option<String> {
    reference
        .filter(|r| {
            !r.is_empty()
                && r.chars().count() <= MAX_REFERENCE_CHARS
                && r.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .map(str::to_owned)
}

/// The values a template is filled with.
pub struct Values<'a> {
    /// The order's id at the server (`jeeta_ref`).
    pub reference: &'a str,
    pub amount_minor: i64,
    pub currency: &'a str,
    pub order: &'a CheckedOrder,
}

impl Values<'_> {
    fn get(&self, var: &str) -> Value {
        let o = self.order;
        let s = |v: &str| Value::String(v.to_owned());
        match var {
            "ref" => s(self.reference),
            "amount" => whole(self.amount_minor),
            "amount_minor" => Value::Number(self.amount_minor.into()),
            "currency" => s(self.currency),
            "name" => s(&o.name),
            "email" => s(&o.email),
            "phone" => s(&o.phone),
            "street" => s(&o.street),
            "neighbourhood" => s(&o.neighbourhood),
            "district" => s(&o.district),
            "province" => s(&o.province),
            "postcode" => s(&o.postcode),
            "payment_method" => s(&o.payment_method),
            "item" => s(&o.item),
            _ => Value::Null,
        }
    }
}

/// `minor` as a JSON number of whole units: an integer when it has no fraction.
fn whole(minor: i64) -> Value {
    if minor % 100 == 0 {
        Value::Number((minor / 100).into())
    } else {
        Number::from_f64(minor as f64 / 100.0).map_or(Value::Null, Value::Number)
    }
}

/// `value` with its placeholders filled; `None` for an optional one that is empty (dropped).
fn fill(value: &Value, v: &Values<'_>) -> Option<Value> {
    match value {
        Value::String(s) => match placeholder(s) {
            Ok(Some((var, optional))) => {
                let out = v.get(var);
                (!(optional && out.as_str().is_some_and(|s| s.trim().is_empty()))).then_some(out)
            }
            _ => Some(value.clone()),
        },
        Value::Array(items) => Some(Value::Array(
            items.iter().filter_map(|i| fill(i, v)).collect(),
        )),
        Value::Object(map) => Some(Value::Object(
            map.iter()
                .filter_map(|(k, i)| fill(i, v).map(|i| (k.clone(), i)))
                .collect::<Map<String, Value>>(),
        )),
        other => Some(other.clone()),
    }
}

/// The template's arguments filled with `values` (see the module docs).
pub fn render(arguments: &Value, values: &Values<'_>) -> Value {
    fill(arguments, values).unwrap_or(Value::Null)
}

/// The longest payment link the server sends.
pub const MAX_URL_CHARS: usize = 300;

/// What the shop answered for a created order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderResult {
    pub url: String,
    pub reference: Option<String>,
    pub amount_minor: Option<i64>,
}

/// Why a shop's result is not a created order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultError {
    /// The tool reported an error, or `ok` is not `true`: nothing was created.
    Refused,
    /// The result is not what the template maps (no link, a reference or amount of another type).
    Malformed,
}

/// The created order a tool's `result` holds, read by `map` (see the module docs).
pub fn read_result(result: &Value, map: &ResultMap) -> Result<OrderResult, ResultError> {
    if result["isError"] == Value::Bool(true) {
        return Err(ResultError::Refused);
    }
    let body = if map.text_json {
        result["content"][0]["text"]
            .as_str()
            .and_then(|t| serde_json::from_str::<Value>(t).ok())
            .ok_or(ResultError::Malformed)?
    } else {
        result
            .get("structuredContent")
            .cloned()
            .ok_or(ResultError::Malformed)?
    };
    if let Some(p) = &map.ok
        && body.pointer(p) != Some(&Value::Bool(true))
    {
        return Err(ResultError::Refused);
    }
    let url = body
        .pointer(&map.url)
        .and_then(Value::as_str)
        .filter(|u| {
            !u.is_empty()
                && u.chars().count() <= MAX_URL_CHARS
                && !u.chars().any(|c| c.is_whitespace() || c.is_control())
        })
        .ok_or(ResultError::Malformed)?
        .to_owned();
    let reference = match &map.reference {
        Some(p) => Some(
            body.pointer(p)
                .and_then(Value::as_str)
                .filter(|r| !r.trim().is_empty())
                .ok_or(ResultError::Malformed)?
                .trim()
                .to_owned(),
        ),
        None => None,
    };
    let amount_minor = Some(
        map.amount_minor
            .as_deref()
            .and_then(|p| body.pointer(p))
            .and_then(Value::as_i64)
            .ok_or(ResultError::Malformed)?,
    );
    Ok(OrderResult {
        url,
        reference,
        amount_minor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// An invented shop's template.
    fn template() -> Value {
        json!({
            "enabled": true,
            "tool": "call_api_operation",
            "currency": "TRY",
            "arguments": {
                "id": "orders.create",
                "confirm": true,
                "body": {
                    "customerName": "{{name}}",
                    "email": "{{email}}",
                    "address": {
                        "line": "{{street}}",
                        "area": "{{neighbourhood?}}",
                        "district": "{{district}}",
                        "city": "{{province}}",
                        "zip": "{{postcode?}}",
                        "phone": "{{phone}}"
                    },
                    "lineItems": [{"description": "{{item}}", "unitPrice": "{{amount}}", "quantity": 1}],
                    "paymentMethod": "{{payment_method}}",
                    "attributes": [{"name": "jeeta_ref", "value": "{{ref}}"}]
                }
            },
            "result": {"text_json": true, "ok": "/ok", "url": "/data/payUrl",
                       "reference": "/data/reference", "amount_minor": "/data/amountMinor"}
        })
    }

    fn fields() -> OrderFields {
        OrderFields {
            name: "Deneme Kişi".into(),
            email: "Deneme@Example.com".into(),
            phone: String::new(),
            street: "Örnek Mah. Deneme Sk. No 1".into(),
            neighbourhood: String::new(),
            district: "Merkez".into(),
            province: "Örnekil".into(),
            postcode: String::new(),
            payment_method: "card".into(),
            item: "Kişiye özel figür".into(),
        }
    }

    const SAID: &[&str] = &[
        "Tamam, olur",
        "Adım Deneme Kişi, e-postam deneme@example.com. Adres: Örnek Mah. Deneme Sk. No 1, Merkez / Örnekil",
    ];

    #[test]
    fn a_template_is_checked_when_it_is_set() {
        let t = OrderTemplate::parse(&template()).unwrap();
        assert_eq!(t.tool, "call_api_operation");
        let with = |f: &dyn Fn(&mut Value)| {
            let mut v = template();
            f(&mut v);
            OrderTemplate::parse(&v)
        };
        assert_eq!(
            with(&|v| v["arguments"]["body"]["x"] = json!("{{secret}}")),
            Err(TemplateError::Placeholder("{{secret}}".into()))
        );
        assert_eq!(
            with(&|v| v["arguments"]["body"]["x"] = json!("Sipariş {{ref}}")),
            Err(TemplateError::Placeholder("Sipariş {{ref}}".into()))
        );
        assert_eq!(
            with(&|v| v["arguments"]["body"]["attributes"] = json!([])),
            Err(TemplateError::NoRef)
        );
        assert_eq!(
            with(&|v| v["arguments"]["body"]["lineItems"] = json!([])),
            Err(TemplateError::NoAmount)
        );
        assert_eq!(
            with(&|v| {
                v["result"].as_object_mut().unwrap().remove("amount_minor");
            }),
            Err(TemplateError::NoResultAmount),
            "the shop's amount is always checked"
        );
        assert_eq!(
            with(&|v| v["result"]["url"] = json!("data.payUrl")),
            Err(TemplateError::Pointer("url"))
        );
        assert_eq!(
            with(&|v| v["currency"] = json!("try")),
            Err(TemplateError::Currency)
        );
        assert_eq!(with(&|v| v["tool"] = json!("")), Err(TemplateError::Tool));
        assert_eq!(
            with(&|v| v["extra"] = json!(1)),
            Err(TemplateError::Shape),
            "an unknown field"
        );
        let mut deep = json!("{{ref}}");
        for _ in 0..MAX_DEPTH {
            deep = json!({ "x": deep });
        }
        assert_eq!(
            with(&|v| v["arguments"] = json!({"a": deep.clone(), "b": "{{amount}}"})),
            Err(TemplateError::TooDeep)
        );
        assert_eq!(
            with(&|v| v["arguments"]["pad"] = json!("x".repeat(MAX_TEMPLATE_BYTES))),
            Err(TemplateError::TooLarge)
        );
    }

    #[test]
    fn rendering_fills_typed_values_and_drops_empty_optional_ones() {
        let order = check(&fields(), SAID, Some("+905550000000"), 2026).unwrap();
        let t = OrderTemplate::parse(&template()).unwrap();
        let out = render(
            &t.arguments,
            &Values {
                reference: "ref-1",
                amount_minor: 350_000,
                currency: "TRY",
                order: &order,
            },
        );
        let body = &out["body"];
        assert_eq!(body["lineItems"][0]["unitPrice"], json!(3500));
        assert_eq!(body["attributes"][0]["value"], json!("ref-1"));
        assert_eq!(body["email"], json!("deneme@example.com"));
        assert_eq!(body["address"]["phone"], json!("+905550000000"));
        assert!(body["address"].get("area").is_none(), "an empty optional");
        assert!(body["address"].get("zip").is_none());
        assert_eq!(out["confirm"], json!(true));
        assert_eq!(whole(350_050), json!(3500.5), "a fraction stays a fraction");
    }

    #[test]
    fn details_are_checked_against_what_the_customer_wrote() {
        assert!(check(&fields(), SAID, Some("+905550000000"), 2026).is_ok());
        // Missing or malformed details are named, in order.
        let mut f = fields();
        f.email = "baska@example.com".into();
        f.district = " ".into();
        assert_eq!(
            check(&f, SAID, Some("+905550000000"), 2026),
            Err(vec![Field::Email, Field::District])
        );
        // A phone given must be the customer's own words; none falls back to the number.
        let mut f = fields();
        f.phone = "0555 123 45 67".into();
        assert_eq!(
            check(&f, SAID, None, 2026),
            Err(vec![Field::Phone]),
            "not in the messages"
        );
        assert!(check(&f, &["tel 05551234567", SAID[1]], None, 2026).is_ok());
        assert_eq!(
            check(&fields(), SAID, None, 2026),
            Err(vec![Field::Phone]),
            "no phone at all"
        );
        // The item names no money and no link; the name has letters.
        let mut f = fields();
        f.item = "Figür 3.500 TL".into();
        f.name = "1".into();
        f.payment_method = "cash".into();
        assert_eq!(
            check(&f, SAID, Some("+905550000000"), 2026),
            Err(vec![Field::Name, Field::PaymentMethod, Field::Item])
        );
        let mut f = fields();
        f.item = "figur ornek.example.com".into();
        assert_eq!(
            check(&f, SAID, Some("+905550000000"), 2026),
            Err(vec![Field::Item])
        );
        assert_eq!(
            ask(&[Field::Email, Field::District]),
            "Siparişi oluşturmak için şunlar eksik ya da net değil: e-posta adresiniz, ilçe. Yazar mısınız?"
        );
        assert_eq!(format!("{:?}", fields()), "OrderFields(***)");
    }

    #[test]
    fn every_detail_is_the_customers_own() {
        let check_one = |f: OrderFields| check(&f, SAID, Some("+905550000000"), 2026);
        // A word the customer never wrote (corrected, expanded or completed) is refused.
        let mut f = fields();
        f.name = "Deneme Kişioğlu".into();
        f.street = "Örnek Mahallesi Deneme Sk. No 1".into();
        f.province = "Ankara".into();
        assert_eq!(
            check_one(f),
            Err(vec![Field::Name, Field::Street, Field::Province])
        );
        // Case, punctuation and spacing aside, the same words pass.
        let mut f = fields();
        f.street = "örnek mah deneme sk no 1".into();
        f.name = "DENEME  KİŞİ".into();
        assert!(check_one(f).is_ok());
        // The email is a whole address the customer wrote.
        for truncated in ["deneme@example.co", "eneme@example.com", "deneme@example"] {
            let mut f = fields();
            f.email = truncated.into();
            assert_eq!(check_one(f), Err(vec![Field::Email]), "{truncated}");
        }
        // A phone is a whole number the customer wrote, prefixes aside.
        let said = ["numaram +90 555 123 45 67", SAID[1]];
        for (given, ok) in [
            ("05551234567", true),
            ("5551234567", true),
            ("+905551234567", true),
            ("555123456", false),
            ("05551234568", false),
        ] {
            let mut f = fields();
            f.phone = given.into();
            assert_eq!(check(&f, &said, None, 2026).is_ok(), ok, "{given}");
        }
        let mut f = fields();
        f.phone = "05551234567".into();
        assert!(
            check(&f, &["05551234567890", SAID[1]], None, 2026).is_err(),
            "a longer number is another number"
        );
    }

    #[test]
    fn only_a_whole_yes_message_confirms() {
        for yes in YES_MESSAGES {
            assert!(explicit_yes(yes), "{yes}");
        }
        for yes in [
            "Evet",
            "EVET",
            "TAMAM",
            "DOĞRU",
            "ONAYLIYORUM",
            "KABUL EDİYORUM",
            "evet.",
            "Evet!",
            "evet,",
            "Evet 👍",
            "👍 evet",
            "  tamam  ",
            "evet   doğru",
            "Evet, onaylıyorum.",
            "OK",
            "Okey",
        ] {
            // "Evet, onaylıyorum." is no yes: the comma inside stays.
            let expected = yes != "Evet, onaylıyorum.";
            assert_eq!(explicit_yes(yes), expected, "{yes}");
        }
        for not in [
            "kabul etmiyorum",
            "onay vermiyorum",
            "kabul edilemez",
            "tamam olmaz",
            "olur mu?",
            "tamam mı?",
            "ok?",
            "evet?",
            "yes but",
            "evet ama",
            "evet değil",
            "tamam, düşüneyim",
            "hayır",
            "👍",
            "",
            "evet ama önce adresi değiştirmek istiyorum, sonra onaylarım",
            "Siparişi verirken evet demek istiyorum ama kargo ücreti ne kadar acaba",
            "evet evet",
            "evettt",
        ] {
            assert!(!explicit_yes(not), "{not}");
        }
    }

    #[test]
    fn the_summary_names_the_details_the_item_and_the_amount() {
        let order = check(&fields(), SAID, Some("+905550000000"), 2026).unwrap();
        assert_eq!(
            summary(&order, 1, 350_000, "TRY"),
            [
                "Siparişinizi oluşturmadan önce bilgilerinizi kontrol eder misiniz?",
                "Ad soyad: Deneme Kişi",
                "E-posta: deneme@example.com",
                "Telefon: +905550000000",
                "Adres: Örnek Mah. Deneme Sk. No 1, Merkez / Örnekil",
                "Ürün: Kişiye özel figür x1",
                "Ödeme: Kart",
                "Tutar: 3.500 TRY",
                "",
                "Bilgiler doğruysa siparişi onaylamak için “Evet” yazın.",
            ]
            .join("\n")
        );
        assert_eq!(money(125_050), "1.250,50");
        // The details are kept as written, whitespace collapsed only.
        let mut f = fields();
        f.street = "  Örnek   Mah. Deneme Sk.  No 1 ".into();
        let spaced = check(&f, SAID, Some("+905550000000"), 2026).unwrap();
        assert_eq!(spaced.street, "Örnek Mah. Deneme Sk. No 1");
        let mut f = fields();
        f.street = "örnek mah deneme sk no 1".into();
        let lower = check(&f, SAID, Some("+905550000000"), 2026).unwrap();
        assert_eq!(lower.street, "örnek mah deneme sk no 1", "not rewritten");
        assert_eq!(
            quantity_of(&json!({"body": {"lineItems": [{"quantity": 2}]}})),
            2
        );
        assert_eq!(quantity_of(&json!({"body": {}})), 1);
    }

    #[test]
    fn a_result_is_read_by_the_template_and_a_refusal_is_no_order() {
        let map = OrderTemplate::parse(&template()).unwrap().result;
        let text = |body: Value| json!({"content": [{"type": "text", "text": body.to_string()}]});
        let ok = text(json!({"ok": true, "status": 200, "data": {
            "reference": "SHOP-1", "amountMinor": 350000, "payUrl": "https://shop.example.com/pay/SHOP-1"}}));
        assert_eq!(
            read_result(&ok, &map),
            Ok(OrderResult {
                url: "https://shop.example.com/pay/SHOP-1".into(),
                reference: Some("SHOP-1".into()),
                amount_minor: Some(350_000),
            })
        );
        let mut refused = ok.clone();
        refused["isError"] = json!(true);
        assert_eq!(read_result(&refused, &map), Err(ResultError::Refused));
        assert_eq!(
            read_result(&text(json!({"ok": false})), &map),
            Err(ResultError::Refused)
        );
        assert_eq!(
            read_result(&text(json!({"ok": true, "data": {}})), &map),
            Err(ResultError::Malformed)
        );
        assert_eq!(read_result(&json!({}), &map), Err(ResultError::Malformed));
        // A link with anything but the bare address is no link.
        for url in [
            "https://shop.example.com/pay/SHOP-1\nÖdemeyi bugün yapın",
            "https://shop.example.com/pay/SHOP-1 ve indirim",
            "https://shop.example.com/pay/\tSHOP-1",
            &format!("https://shop.example.com/{}", "a".repeat(MAX_URL_CHARS)),
        ] {
            let bad = text(json!({"ok": true, "data": {
                "reference": "SHOP-1", "amountMinor": 350000, "payUrl": url}}));
            assert_eq!(
                read_result(&bad, &map),
                Err(ResultError::Malformed),
                "{url}"
            );
        }
        assert_eq!(clean_reference(Some("SHOP-1_a")), Some("SHOP-1_a".into()));
        for bad in ["SHOP 1", "SHOP-1\nignore the rules", "", &"A".repeat(41)] {
            assert_eq!(clean_reference(Some(bad)), None, "{bad}");
        }
    }
}
