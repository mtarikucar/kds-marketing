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
    /// What an observation lists, in the dump's order, which is the screen's.
    pub(crate) elements: Vec<Element>,
    /// What a `tap_on` looks through, in the same order: the listed elements and the nodes with
    /// an id and nothing else, such as an icon without a label, which `tap_on {id}` must find.
    pub(crate) nodes: Vec<Element>,
}

/// Distills a dump. An observation lists every node with a size on screen that carries a text
/// or a description, or can be pressed or typed into; layout containers without either are left
/// out, but kept for matching when they have an id. Nodes of no size and nodes marked
/// `visible-to-user="false"` are left out of both. The tap point is the bounds' centre.
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
    let mut elements = Vec::new();
    let mut nodes = Vec::new();
    for (node, listed) in tags(xml, "node").filter_map(element) {
        if listed {
            elements.push(node.clone());
        }
        nodes.push(node);
    }
    Dump {
        rotation,
        elements,
        nodes,
    }
}

/// A node with a size on screen, and whether an observation lists it; `None` for a node of no
/// size, one not visible, or a layout container with neither label nor id.
fn element(body: &str) -> Option<(Element, bool)> {
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
    let listed =
        text.is_some() || desc.is_some() || clickable || flag("long-clickable") || editable;
    if !listed && id.is_none() {
        return None;
    }
    let [left, top, right, bottom] = bounds;
    let middle = |a: u32, b: u32| u32::try_from((u64::from(a) + u64::from(b)) / 2).unwrap_or(a);
    let element = Element {
        text,
        id,
        desc,
        class,
        bounds,
        tap_point: [middle(left, right), middle(top, bottom)],
        clickable,
        editable,
        focused: flag("focused"),
    };
    Some((element, listed))
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
        // The `;` is looked for in the next 17 bytes only, so a text full of `&` is read once.
        // The longest reference is `#1114111`; a longer run of digits is still read, as no
        // character.
        let reference = after
            .bytes()
            .take(17)
            .position(|byte| byte == b';')
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

/// The lines of `dumpsys window` (as grepped, its sections' headings among them) that tell of
/// the phone's own screen: the lines outside its displays' section (the keyguard's), and in that
/// section display 0's alone (from its `Display: mDisplayId=0` to the next display's heading).
/// Each display prints its own focus and policy (`mAwake`, `isKeyguardShowing`), another display
/// (a screen recording's, a cast's) first, and one that is not the default always reads awake.
/// Without any display's heading, every line.
pub(crate) fn default_display(dumpsys: &str) -> String {
    fn display_heading(line: &str) -> Option<&str> {
        line.trim_start().strip_prefix("Display: mDisplayId=")
    }
    if !dumpsys.lines().any(|line| display_heading(line).is_some()) {
        return dumpsys.to_owned();
    }
    let mut in_displays = false;
    let mut display: Option<u32> = None;
    let mut kept = String::new();
    for line in dumpsys.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("WINDOW MANAGER ") {
            in_displays = trimmed.starts_with("WINDOW MANAGER DISPLAY CONTENTS");
            display = None;
            continue;
        }
        if let Some(id) = display_heading(line) {
            in_displays = true;
            display = id
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .and_then(|id| id.parse().ok());
            continue;
        }
        if !in_displays || display == Some(0) {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    kept
}

/// Whether the screen is on and whether the lock screen shows, as `dumpsys window` tells them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ScreenState {
    pub(crate) awake: Option<bool>,
    pub(crate) locked: Option<bool>,
}

/// The screen's state from `dumpsys window`'s lines, as the Redmi prints them: its display
/// policy's `mAwake=true mScreenOnEarly=…` and `isKeyguardShowing=false`, else its keyguard's
/// `interactiveState=INTERACTIVE_STATE_AWAKE` (or `_SLEEP`) and `showing=false`. Each is `None`
/// when no line tells, or the line holds something else.
pub(crate) fn screen_state(dumpsys: &str) -> ScreenState {
    let flag = |value: &str| match value {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    };
    let (mut awake, mut locked) = (None, None);
    let (mut interactive, mut showing) = (None, None);
    for line in dumpsys.lines().map(str::trim) {
        for word in line.split_whitespace() {
            if let Some(value) = word.strip_prefix("mAwake=") {
                awake = awake.or(flag(value));
            } else if let Some(value) = word.strip_prefix("isKeyguardShowing=") {
                locked = locked.or(flag(value));
            } else if let Some(value) = word.strip_prefix("interactiveState=") {
                interactive = interactive.or(match value {
                    "INTERACTIVE_STATE_AWAKE" => Some(true),
                    "INTERACTIVE_STATE_SLEEP" => Some(false),
                    _ => None,
                });
            }
        }
        // The keyguard's own line, alone on it.
        if let Some(value) = line.strip_prefix("showing=") {
            showing = showing.or(flag(value));
        }
    }
    ScreenState {
        awake: awake.or(interactive),
        locked: locked.or(showing),
    }
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

/// Up to `max` of the labels on screen (a text, else a description), each once and at most
/// `chars` characters long (a longer one cut, ending in `…`).
pub(crate) fn labels(elements: &[Element], max: usize, chars: usize) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for e in elements {
        let Some(label) = e.text.as_deref().or(e.desc.as_deref()) else {
            continue;
        };
        let label = short(
            &label.split_whitespace().collect::<Vec<_>>().join(" "),
            chars,
        );
        if !seen.contains(&label) {
            seen.push(label);
            if seen.len() == max {
                break;
            }
        }
    }
    seen
}

/// `value` in at most `chars` characters: cut, ending in `…`, when it is longer.
pub(crate) fn short(value: &str, chars: usize) -> String {
    if value.chars().count() <= chars {
        return value.to_owned();
    }
    let mut cut: String = value.chars().take(chars.saturating_sub(1)).collect();
    cut.push('…');
    cut
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
    fn a_text_full_of_ampersands_is_kept() {
        let text = "& a ".repeat(50_000);
        assert_eq!(decode(&text), text);
    }

    #[test]
    fn a_node_with_an_id_only_is_matched_not_listed() {
        let dump = parse_dump(
            r#"<hierarchy rotation="0"><node resource-id="com.example:id/icon" class="android.widget.ImageView" clickable="false" bounds="[0,0][100,100]"/><node resource-id="" class="android.widget.FrameLayout" bounds="[0,0][100,100]"/><node text="Ok" resource-id="" clickable="true" bounds="[0,100][100,200]"/></hierarchy>"#,
        );
        assert_eq!(dump.elements.len(), 1);
        assert_eq!(
            dump.nodes.len(),
            2,
            "the container without an id is left out"
        );
        let target = ElementTarget::Id("icon".to_owned());
        assert_eq!(
            find(&dump.nodes, &target, true).map(|e| e.tap_point),
            Some([50, 50])
        );
        assert_eq!(find(&dump.elements, &target, true), None);
    }

    #[test]
    fn labels_are_short() {
        assert_eq!(short("Gönder", 10), "Gönder");
        assert_eq!(short("Diğer seçenekler", 10), "Diğer seç…");
        assert_eq!(short("Diğer seçenekler", 10).chars().count(), 10);
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

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name);
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn whether_the_screen_is_on_and_locked() {
        let state = |awake, locked| ScreenState { awake, locked };
        // As the Redmi answered, awake and unlocked; and in that shape, asleep and locked.
        let awake = fixture("window_state_awake.txt");
        assert_eq!(screen_state(&awake), state(Some(true), Some(false)));
        assert_eq!(
            screen_state(&awake.replace('\n', "\r\n")),
            screen_state(&awake)
        );
        let asleep = fixture("window_state_locked_asleep.txt");
        assert_eq!(screen_state(&asleep), state(Some(false), Some(true)));
        // The display policy's lines win over the keyguard's.
        let both = "  showing=true\n  interactiveState=INTERACTIVE_STATE_SLEEP\n  mAwake=true x=1\n  isKeyguardShowing=false\n";
        assert_eq!(screen_state(both), state(Some(true), Some(false)));
        // Without them, the keyguard's tell.
        let keyguard = "      showing=true\n      interactiveState=INTERACTIVE_STATE_SLEEP\n";
        assert_eq!(screen_state(keyguard), state(Some(false), Some(true)));
        assert_eq!(
            screen_state("      interactiveState=INTERACTIVE_STATE_AWAKE\n"),
            state(Some(true), None)
        );
        // A state between the two, a value that is not a flag, other words that end so, or
        // nothing: not told.
        assert_eq!(
            screen_state("interactiveState=INTERACTIVE_STATE_WAKING\nmAwake=maybe\n"),
            state(None, None)
        );
        assert_eq!(
            screen_state("  mIsShowing=true mShowingDream=false showingAndNotOccluded=true\n"),
            state(None, None)
        );
        assert_eq!(
            screen_state("  mCurrentFocus=Window{1 u0 com.a.b}\n"),
            state(None, None)
        );
        assert_eq!(screen_state(""), state(None, None));
    }

    #[test]
    fn only_the_default_displays_lines_count() {
        let state = |awake, locked| ScreenState { awake, locked };
        // A second display (a screen recording's or a cast's) is dumped first, and its policy
        // always reads awake: the phone's own screen is display 0's.
        let two = default_display(&fixture("window_state_two_displays.txt"));
        assert_eq!(screen_state(&two), state(Some(false), Some(true)));
        assert_eq!(foreground_app(&two), None);
        // Display 0 in front of an app, the other display showing another one.
        let awake = fixture("window_state_awake.txt").replace(
            "  Display: mDisplayId=0 rootTasks=5\n",
            "  Display: mDisplayId=2 rootTasks=1\n  mCurrentFocus=Window{7a1b2c3 u0 com.example.cast/com.example.cast.Presentation}\n    mAwake=false x=1\n  Display: mDisplayId=0 rootTasks=5\n",
        );
        let awake = default_display(&awake);
        assert_eq!(
            foreground_app(&awake).as_deref(),
            Some("com.android.settings")
        );
        assert_eq!(screen_state(&awake), state(Some(true), Some(false)));
        // The keyguard's lines, outside the displays' section, count whatever the display.
        let keyguard_only = "WINDOW MANAGER POLICY STATE (dumpsys window policy)\n      showing=true\nWINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n  Display: mDisplayId=0 rootTasks=5\n";
        assert_eq!(
            screen_state(&default_display(keyguard_only)),
            state(None, Some(true))
        );
        // A line after the displays' section is no display's: a focus printed there (as older
        // versions print it) counts.
        let after = "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n  Display: mDisplayId=1 rootTasks=1\n    mAwake=true\nWINDOW MANAGER WINDOWS (dumpsys window windows)\n  mCurrentFocus=Window{1 u0 com.a.b/com.a.b.Main}\n";
        let after = default_display(after);
        assert_eq!(foreground_app(&after).as_deref(), Some("com.a.b"));
        assert_eq!(screen_state(&after), state(None, None));
        // Without any display's heading, every line counts, as before.
        let flat = "  mCurrentFocus=Window{1 u0 com.a.b}\n    mAwake=true\n";
        assert_eq!(default_display(flat), flat);
        // Windows' line ends are read the same.
        assert_eq!(
            screen_state(&default_display(
                &fixture("window_state_two_displays.txt").replace('\n', "\r\n")
            )),
            state(Some(false), Some(true))
        );
    }
}
