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
//!   within its length, the email and a given phone found in the customer's own messages, the
//!   item naming no money and no link. They exist in memory only, between the model's answer and
//!   the shop's call: `Debug` masks every one of them.
//! - **The answer** ([`read_result`]): an `isError` result, or one whose `ok` is not `true`, is a
//!   refusal; otherwise the link, and the reference and the amount when the template maps them.

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
        "Siparişi oluşturmak için şunlar eksik: {}. Yazar mısınız?",
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

/// The digits of `s`, in order.
fn digits(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// Whether `text` holds at least `n` letters.
fn letters(text: &str, n: usize) -> bool {
    text.chars().filter(|c| c.is_alphabetic()).count() >= n
}

fn within(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.chars().count())
}

/// `fields` checked against what the customer wrote in this journey (`customer`, their messages'
/// texts) and the conversation's own number (`own_phone`, used when no other phone is given);
/// `Err` with every detail missing or malformed, in a stable order. `year` is the calendar year
/// the item's money rules read in.
pub fn check(
    fields: &OrderFields,
    customer: &[&str],
    own_phone: Option<&str>,
    year: i32,
) -> Result<CheckedOrder, Vec<Field>> {
    let t = |s: &str| s.trim().to_owned();
    let mut bad = Vec::new();
    let said = customer.join("\n").to_lowercase();
    let said_digits = digits(&customer.join(" "));

    let name = t(&fields.name);
    if !within(&name, 1, 120) || !letters(&name, 2) {
        bad.push(Field::Name);
    }
    let email = match normalise_identity(IdentityChannel::Email, &fields.email) {
        Ok(e) if e.len() <= 254 && said.contains(&e) => e,
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
        let d = digits(&given);
        // Found generously: its last ten digits anywhere in the customer's digits.
        let tail = &d[d.len().saturating_sub(10)..];
        if only && (10..=15).contains(&d.len()) && said_digits.contains(tail) {
            given
        } else {
            bad.push(Field::Phone);
            String::new()
        }
    };
    let street = t(&fields.street);
    if !within(&street, 1, 300) {
        bad.push(Field::Street);
    }
    let neighbourhood = t(&fields.neighbourhood);
    if !within(&neighbourhood, 0, 120) {
        bad.push(Field::Neighbourhood);
    }
    let district = t(&fields.district);
    if !within(&district, 1, 120) {
        bad.push(Field::District);
    }
    let province = t(&fields.province);
    if !within(&province, 1, 120) {
        bad.push(Field::Province);
    }
    let postcode = t(&fields.postcode);
    if !within(&postcode, 0, 20) {
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

/// Whether `acceptance` (the customer's own words accepting the price, as the model copied them)
/// is found, normalised, in one of `after` (the customer's messages after the quote went out).
/// It proves only that the customer wrote these words, not that they mean yes.
pub fn acceptance_found(acceptance: &str, after: &[&str]) -> bool {
    let words = normalise_text(acceptance.trim());
    let words = words.trim();
    words.chars().count() >= 2 && after.iter().any(|m| normalise_text(m).contains(words))
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
        .filter(|u| !u.trim().is_empty())
        .ok_or(ResultError::Malformed)?
        .trim()
        .to_owned();
    let reference = match &map.reference {
        Some(p) => Some(
            body.pointer(p)
                .and_then(Value::as_str)
                .filter(|r| !r.trim().is_empty() && r.chars().count() <= 120)
                .ok_or(ResultError::Malformed)?
                .trim()
                .to_owned(),
        ),
        None => None,
    };
    let amount_minor = match &map.amount_minor {
        Some(p) => Some(
            body.pointer(p)
                .and_then(Value::as_i64)
                .ok_or(ResultError::Malformed)?,
        ),
        None => None,
    };
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

    const SAID: &[&str] = &["Tamam, olur", "e-postam deneme@example.com"];

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
            "Siparişi oluşturmak için şunlar eksik: e-posta adresiniz, ilçe. Yazar mısınız?"
        );
        assert_eq!(format!("{:?}", fields()), "OrderFields(***)");
    }

    #[test]
    fn acceptance_is_the_customers_own_words() {
        assert!(acceptance_found("tamam olur", &["Tamam olur, gönderelim"]));
        assert!(acceptance_found("TAMAM", &["tamam"]));
        assert!(!acceptance_found("evet", &["Tamam olur"]));
        assert!(!acceptance_found("e", &["evet"]), "too short");
        assert!(!acceptance_found("evet", &[]), "no message after the quote");
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
    }
}
