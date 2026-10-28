//! Reading the screen: a `uiautomator dump` distilled to the elements a person could read or
//! press, the screen's size and rotation, the app in front, and finding the element a `tap_on`
//! names.
//!
//! The dump is XML of a fixed, flat shape (`<hierarchy rotation="…">` and nested `<node … />`
//! elements with double-quoted attributes), read here by a small scanner rather than an XML
//! library: a dump cut short or malformed yields fewer elements, never a parse error.

use jt_device_protocol::{Element, ElementTarget, MAX_TEXT_CHARS, Screen};

/// The screen as one dump saw it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Dump {
    /// The rotation in degrees (0, 90, 180, 270).
    pub(crate) rotation: u16,
    /// The elements in the dump's order, which is the screen's.
    pub(crate) elements: Vec<Element>,
}

/// Distills a dump: every node with a size on screen that carries a text or a description, or
/// can be pressed or typed into. Layout containers without either are left out; so are nodes
/// of no size and nodes marked `visible-to-user="false"`. The tap point is the bounds' centre.
pub(crate) fn parse_dump(xml: &str) -> Dump {
    let rotation = tags(xml, "hierarchy")
        .next()
        .and_then(|body| {
            attributes(body)
                .into_iter()
                .find(|(name, _)| *name == "rotation")
        })
        .and_then(|(_, value)| value.trim().parse::<u16>().ok())
        .map_or(0, |value| match value {
            // Quarter turns (`Surface.ROTATION_*`), or degrees already.
            0..=3 => value * 90,
            90 | 180 | 270 => value,
            _ => 0,
        });
    let elements = tags(xml, "node").filter_map(element).collect();
    Dump { rotation, elements }
}

fn element(body: &str) -> Option<Element> {
    let attrs = attributes(body);
    let raw = |name: &str| {
        attrs
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, value)| *value)
    };
    let flag = |name: &str| raw(name) == Some("true");
    if raw("visible-to-user") == Some("false") {
        return None;
    }
    let bounds = parse_bounds(raw("bounds")?)?;
    let label = |name: &str| {
        raw(name)
            .map(decode)
            .filter(|value| !value.trim().is_empty())
            .map(|value| cut(&value))
    };
    let text = label("text");
    let desc = label("content-desc");
    let id = label("resource-id");
    let class = label("class");
    let clickable = flag("clickable");
    let editable = class.as_deref().is_some_and(|class| {
        let name = class.rsplit('.').next().unwrap_or(class);
        name.ends_with("EditText") || name.ends_with("AutoCompleteTextView")
    });
    if text.is_none() && desc.is_none() && !clickable && !flag("long-clickable") && !editable {
        return None;
    }
    let [left, top, right, bottom] = bounds;
    let middle = |a: u32, b: u32| u32::try_from((u64::from(a) + u64::from(b)) / 2).unwrap_or(a);
    Some(Element {
        text,
        id,
        desc,
        class,
        bounds,
        tap_point: [middle(left, right), middle(top, bottom)],
        clickable,
        editable,
        focused: flag("focused"),
    })
}

/// `[left,top][right,bottom]`, each side kept on screen (at least 0); `None` without a size.
fn parse_bounds(raw: &str) -> Option<[u32; 4]> {
    let mut sides = raw
        .split(|c: char| !(c.is_ascii_digit() || c == '-'))
        .filter(|part| !part.is_empty())
        .map(|part| {
            part.parse::<i64>()
                .ok()
                .map(|n| u32::try_from(n.max(0)).unwrap_or(u32::MAX))
        });
    let bounds = [
        sides.next()??,
        sides.next()??,
        sides.next()??,
        sides.next()??,
    ];
    (bounds[2] > bounds[0] && bounds[3] > bounds[1]).then_some(bounds)
}

/// A string of the observation: at most [`MAX_TEXT_CHARS`] characters, as the protocol takes.
fn cut(value: &str) -> String {
    value.chars().take(MAX_TEXT_CHARS).collect()
}

/// The attribute text of each `<name …>` tag, in order.
fn tags<'a>(xml: &'a str, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    let mut rest = xml;
    std::iter::from_fn(move || {
        loop {
            let open = rest.find('<')?;
            let after = &rest[open + 1..];
            let named = after.strip_prefix(name).filter(|tail| {
                tail.chars()
                    .next()
                    .is_some_and(|c| c.is_whitespace() || c == '/' || c == '>')
            });
            let Some(body) = named else {
                rest = after;
                continue;
            };
            // The tag ends at the first `>` outside a quoted value: a value may hold a `>`.
            let mut quote = None;
            let end = body.char_indices().find_map(|(i, c)| {
                match (quote, c) {
                    (None, '"' | '\'') => quote = Some(c),
                    (Some(q), c) if c == q => quote = None,
                    (None, '>') => return Some(i),
                    _ => {}
                }
                None
            });
            let Some(end) = end else {
                rest = "";
                return None;
            };
            rest = &body[end + 1..];
            return Some(body[..end].trim_end_matches('/'));
        }
    })
}

/// The `name="value"` pairs of a tag, values as written (not yet decoded).
fn attributes(body: &str) -> Vec<(&str, &str)> {
    let mut pairs = Vec::new();
    let mut rest = body;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '/');
        let Some(eq) = rest.find('=') else {
            return pairs;
        };
        let name = rest[..eq].trim();
        let value = rest[eq + 1..].trim_start();
        let Some(quote) = value.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            return pairs;
        };
        let Some(close) = value[1..].find(quote) else {
            return pairs;
        };
        pairs.push((name, &value[1..1 + close]));
        rest = &value[1 + close + 1..];
    }
}

/// An attribute value as text: the named references of XML (`&amp;`, `&lt;`, `&gt;`, `&quot;`,
/// `&apos;`) and numeric ones (`&#10;`, `&#xFC;`) decoded. A character beyond the first plane
/// written as two references to its UTF-16 halves is put back together; a lone half, a number
/// that is no character, and NUL become U+FFFD. What is not a reference stays as it is.
pub(crate) fn decode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    // A high surrogate waiting for its low half.
    let mut pending = false;
    let mut high = 0u32;
    let flush = |out: &mut String, pending: &mut bool| {
        if std::mem::take(pending) {
            out.push('\u{FFFD}');
        }
    };
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        if amp > 0 {
            flush(&mut out, &mut pending);
            out.push_str(&rest[..amp]);
        }
        let after = &rest[amp + 1..];
        let reference = after
            .find(';')
            // The longest is `#1114111`; a longer run of digits is still read, as no character.
            .filter(|end| *end <= 16)
            .and_then(|end| Some((end, reference(&after[..end])?)));
        let Some((end, unit)) = reference else {
            flush(&mut out, &mut pending);
            out.push('&');
            rest = after;
            continue;
        };
        rest = &after[end + 1..];
        match unit {
            Reference::Char(c) => {
                flush(&mut out, &mut pending);
                out.push(c);
            }
            Reference::High(h) => {
                flush(&mut out, &mut pending);
                pending = true;
                high = h;
            }
            Reference::Low(low) => {
                if std::mem::take(&mut pending) {
                    let joined = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                    out.push(char::from_u32(joined).unwrap_or('\u{FFFD}'));
                } else {
                    out.push('\u{FFFD}');
                }
            }
        }
    }
    flush(&mut out, &mut pending);
    out.push_str(rest);
    out.replace('\0', "\u{FFFD}")
}

enum Reference {
    Char(char),
    High(u32),
    Low(u32),
}

/// What the text between `&` and `;` stands for, if it is a reference.
fn reference(name: &str) -> Option<Reference> {
    let named = match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => None,
    };
    if let Some(c) = named {
        return Some(Reference::Char(c));
    }
    let number = name.strip_prefix('#')?;
    let (digits, radix) = match number.strip_prefix(['x', 'X']) {
        Some(hex) => (hex, 16),
        None => (number, 10),
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    let Ok(code) = u32::from_str_radix(digits, radix) else {
        return Some(Reference::Char('\u{FFFD}'));
    };
    Some(match code {
        0xD800..=0xDBFF => Reference::High(code),
        0xDC00..=0xDFFF => Reference::Low(code),
        0 => Reference::Char('\u{FFFD}'),
        _ => Reference::Char(char::from_u32(code).unwrap_or('\u{FFFD}')),
    })
}

/// The screen's size from `wm size`: the override size when one is set, else the physical one.
pub(crate) fn screen_size(wm_size: &str) -> Option<(u32, u32)> {
    let size_after = |label: &str| {
        wm_size.lines().find_map(|line| {
            let (w, h) = line.trim().strip_prefix(label)?.trim().split_once('x')?;
            Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
        })
    };
    size_after("Override size:").or_else(|| size_after("Physical size:"))
}

/// The screen as it is held: `(w, h)` is the size in its natural orientation, swapped when it
/// is turned a quarter.
pub(crate) fn screen(size: (u32, u32), rotation: u16) -> Screen {
    let (w, h) = if rotation % 180 == 90 {
        (size.1, size.0)
    } else {
        size
    };
    Screen { w, h, rotation }
}

/// The package of the window in front, from `dumpsys window`'s `mCurrentFocus=Window{… u0
/// com.miui.home/com.miui.home.launcher.Launcher}`: the window's name up to its `/`, or the
/// name itself when it is dotted like a package. `None` when nothing has the focus or the
/// window is the system's own (`StatusBar`).
pub(crate) fn foreground_app(dumpsys: &str) -> Option<String> {
    dumpsys.lines().find_map(|line| {
        let focus = line.split_once("mCurrentFocus=")?.1.trim();
        let window = focus.strip_prefix("Window{")?;
        let window = window.strip_suffix('}').unwrap_or(window);
        let name = window.split_whitespace().last()?;
        let package = match name.split_once('/') {
            Some((package, _)) => package,
            None if name.contains('.') => name,
            None => return None,
        };
        (!package.is_empty()).then(|| cut(package))
    })
}

/// The element a `tap_on` names: an exact match first (the first one that can be pressed, else
/// the first), then, unless `exact`, one whose value holds the target whatever its case (the
/// shortest such value, then one that can be pressed, then the first). An id matches whole
/// (`com.whatsapp:id/entry`) or by its name after the package (`entry`).
pub(crate) fn find<'a>(
    elements: &'a [Element],
    target: &ElementTarget,
    exact: bool,
) -> Option<&'a Element> {
    let values = |e: &'a Element| -> Vec<&'a str> {
        match target {
            ElementTarget::Text(_) => e.text.as_deref().into_iter().collect(),
            ElementTarget::Desc(_) => e.desc.as_deref().into_iter().collect(),
            ElementTarget::Id(_) => {
                e.id.as_deref()
                    .into_iter()
                    .flat_map(|id| {
                        let short = id.split_once(":id/").map(|(_, name)| name);
                        std::iter::once(id).chain(short)
                    })
                    .collect()
            }
        }
    };
    let needle = match target {
        ElementTarget::Text(v) | ElementTarget::Id(v) | ElementTarget::Desc(v) => v.as_str(),
    };
    let equal: Vec<&Element> = elements
        .iter()
        .filter(|e| values(e).contains(&needle))
        .collect();
    if let Some(hit) = equal
        .iter()
        .copied()
        .find(|e| e.clickable)
        .or_else(|| equal.first().copied())
    {
        return Some(hit);
    }
    if exact {
        return None;
    }
    let lower = needle.to_lowercase();
    elements
        .iter()
        .filter_map(|e| {
            let len = values(e)
                .into_iter()
                .filter(|value| value.to_lowercase().contains(&lower))
                .map(|value| value.chars().count())
                .min()?;
            Some((len, !e.clickable, e))
        })
        .min_by_key(|(len, unpressable, _)| (*len, *unpressable))
        .map(|(_, _, e)| e)
}

/// Up to `max` of the labels on screen (a text, else a description), each once and short.
pub(crate) fn labels(elements: &[Element], max: usize) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for e in elements {
        let Some(label) = e.text.as_deref().or(e.desc.as_deref()) else {
            continue;
        };
        let label: String = label.split_whitespace().collect::<Vec<_>>().join(" ");
        let label: String = label.chars().take(30).collect();
        if !seen.contains(&label) {
            seen.push(label);
            if seen.len() == max {
                break;
            }
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_without_a_size_or_off_screen_sides() {
        assert_eq!(parse_bounds("[0,84][1080,231]"), Some([0, 84, 1080, 231]));
        assert_eq!(parse_bounds("[-20,10][40,50]"), Some([0, 10, 40, 50]));
        assert_eq!(parse_bounds("[0,0][0,0]"), None);
        assert_eq!(parse_bounds("[10,10][10,20]"), None);
        assert_eq!(parse_bounds("[1,2][3"), None);
        assert_eq!(parse_bounds(""), None);
    }

    #[test]
    fn a_tag_ends_outside_its_quotes() {
        let body: Vec<&str> = tags(
            r#"<a/><node text="5 > 3" b='x'/><nodes x="1"/><node c="2">"#,
            "node",
        )
        .collect();
        assert_eq!(body, [r#" text="5 > 3" b='x'"#, r#" c="2""#]);
        assert_eq!(attributes(body[0]), [("text", "5 > 3"), ("b", "x")]);
        // Cut short: what came before stays.
        assert_eq!(tags(r#"<node a="1"/><node b="2"#, "node").count(), 1);
    }

    #[test]
    fn references() {
        assert_eq!(decode("a &amp;&lt;&gt;&quot;&apos; b"), "a &<>\"' b");
        assert_eq!(decode("&#10;&#x41;&#X42;"), "\nAB");
        assert_eq!(decode("&#55357;&#56832;"), "😀");
        assert_eq!(decode("&#56832;&#55357;x"), "\u{FFFD}\u{FFFD}x");
        assert_eq!(decode("&#;&#x;&#12a; & ;"), "&#;&#x;&#12a; & ;");
        assert_eq!(decode("&#999999999999;"), "\u{FFFD}");
        assert_eq!(decode("tail &amp"), "tail &amp");
    }

    #[test]
    fn rotation_and_size() {
        assert_eq!(parse_dump(r#"<hierarchy rotation="1">"#).rotation, 90);
        assert_eq!(parse_dump(r#"<hierarchy rotation="270">"#).rotation, 270);
        assert_eq!(parse_dump(r#"<hierarchy>"#).rotation, 0);
        assert_eq!(
            screen_size("Physical size: 720x1650\r\n"),
            Some((720, 1650))
        );
        assert_eq!(screen_size("nothing"), None);
        assert_eq!(
            screen((720, 1650), 90),
            Screen {
                w: 1650,
                h: 720,
                rotation: 90
            }
        );
        assert_eq!(
            screen((720, 1650), 180),
            Screen {
                w: 720,
                h: 1650,
                rotation: 180
            }
        );
    }

    #[test]
    fn the_app_in_front() {
        assert_eq!(
            foreground_app(
                "  mCurrentFocus=Window{3fa1a3b u0 com.miui.home/com.miui.home.launcher.Launcher}\r\n"
            ),
            Some("com.miui.home".to_owned())
        );
        assert_eq!(foreground_app("  mCurrentFocus=null\n"), None);
        assert_eq!(
            foreground_app("  mCurrentFocus=Window{1 u0 StatusBar}\n"),
            None
        );
        assert_eq!(
            foreground_app("  mCurrentFocus=null\n  mCurrentFocus=Window{2 u0 com.a.b}\n"),
            Some("com.a.b".to_owned())
        );
        assert_eq!(foreground_app(""), None);
    }
}
