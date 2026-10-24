//! Emoji syntax recognition; other graphemes retain their scalar weights.
//! Unicode 17 Emoji and Emoji_Modifier_Base ranges, matching unicode-segmentation's data.
//! Source: https://www.unicode.org/Public/17.0.0/ucd/emoji/emoji-data.txt
//! Unicode data © 2025 Unicode, Inc.; see UNICODE-LICENSE in this directory.
//! This recognizes emoji syntax, not a complete versioned RGI-sequence allowlist.

pub(super) fn is_emoji(cluster: &str) -> bool {
    let mut chars = cluster.chars().peekable();
    let Some(first) = chars.peek().copied() else {
        return false;
    };
    if matches!(first, '#' | '*' | '0'..='9') {
        chars.next();
        if chars.peek() == Some(&'\u{fe0f}') {
            chars.next();
        }
        return chars.next() == Some('\u{20e3}') && chars.next().is_none();
    }
    if regional(first) {
        chars.next();
        return chars.next().is_some_and(regional) && chars.next().is_none();
    }
    if first == '\u{1f3f4}' && chars.clone().nth(1).is_some_and(tag) {
        chars.next();
        while chars.peek().copied().is_some_and(tag) {
            chars.next();
        }
        return chars.next() == Some('\u{e007f}') && chars.next().is_none();
    }
    loop {
        let Some(base) = chars.next().filter(|c| emoji_base(*c)) else {
            return false;
        };
        // These text symbols retain weight one unless emoji presentation is explicit.
        if matches!(base, '©' | '®') && chars.peek() != Some(&'\u{fe0f}') {
            return false;
        }
        if chars.peek() == Some(&'\u{fe0f}') {
            chars.next();
        }
        if chars
            .peek()
            .is_some_and(|c| matches!(*c as u32, 0x1f3fb..=0x1f3ff))
        {
            if !modifier_base(base) {
                return false;
            }
            chars.next();
        }
        match chars.next() {
            None => return true,
            Some('\u{200d}') => {}
            _ => return false,
        }
    }
}
fn regional(c: char) -> bool {
    matches!(c as u32, 0x1f1e6..=0x1f1ff)
}
fn tag(c: char) -> bool {
    matches!(c as u32, 0xe0030..=0xe0039 | 0xe0061..=0xe007a)
}

// Emoji property, excluding keycap bases, regional indicators and skin modifiers.
fn emoji_base(c: char) -> bool {
    matches!(c as u32,
        0xa9
            | 0xae
            | 0x203c
            | 0x2049
            | 0x2122
            | 0x2139
            | 0x2194..=0x2199
            | 0x21a9..=0x21aa
            | 0x231a..=0x231b
            | 0x2328
            | 0x23cf
            | 0x23e9..=0x23f3
            | 0x23f8..=0x23fa
            | 0x24c2
            | 0x25aa..=0x25ab
            | 0x25b6
            | 0x25c0
            | 0x25fb..=0x25fe
            | 0x2600..=0x2604
            | 0x260e
            | 0x2611
            | 0x2614..=0x2615
            | 0x2618
            | 0x261d
            | 0x2620
            | 0x2622..=0x2623
            | 0x2626
            | 0x262a
            | 0x262e..=0x262f
            | 0x2638..=0x263a
            | 0x2640
            | 0x2642
            | 0x2648..=0x2653
            | 0x265f..=0x2660
            | 0x2663
            | 0x2665..=0x2666
            | 0x2668
            | 0x267b
            | 0x267e..=0x267f
            | 0x2692..=0x2697
            | 0x2699
            | 0x269b..=0x269c
            | 0x26a0..=0x26a1
            | 0x26a7
            | 0x26aa..=0x26ab
            | 0x26b0..=0x26b1
            | 0x26bd..=0x26be
            | 0x26c4..=0x26c5
            | 0x26c8
            | 0x26ce..=0x26cf
            | 0x26d1
            | 0x26d3..=0x26d4
            | 0x26e9..=0x26ea
            | 0x26f0..=0x26f5
            | 0x26f7..=0x26fa
            | 0x26fd
            | 0x2702
            | 0x2705
            | 0x2708..=0x270d
            | 0x270f
            | 0x2712
            | 0x2714
            | 0x2716
            | 0x271d
            | 0x2721
            | 0x2728
            | 0x2733..=0x2734
            | 0x2744
            | 0x2747
            | 0x274c
            | 0x274e
            | 0x2753..=0x2755
            | 0x2757
            | 0x2763..=0x2764
            | 0x2795..=0x2797
            | 0x27a1
            | 0x27b0
            | 0x27bf
            | 0x2934..=0x2935
            | 0x2b05..=0x2b07
            | 0x2b1b..=0x2b1c
            | 0x2b50
            | 0x2b55
            | 0x3030
            | 0x303d
            | 0x3297
            | 0x3299
            | 0x1f004
            | 0x1f0cf
            | 0x1f170..=0x1f171
            | 0x1f17e..=0x1f17f
            | 0x1f18e
            | 0x1f191..=0x1f19a
            | 0x1f201..=0x1f202
            | 0x1f21a
            | 0x1f22f
            | 0x1f232..=0x1f23a
            | 0x1f250..=0x1f251
            | 0x1f300..=0x1f321
            | 0x1f324..=0x1f393
            | 0x1f396..=0x1f397
            | 0x1f399..=0x1f39b
            | 0x1f39e..=0x1f3f0
            | 0x1f3f3..=0x1f3f5
            | 0x1f3f7..=0x1f3fa
            | 0x1f400..=0x1f4fd
            | 0x1f4ff..=0x1f53d
            | 0x1f549..=0x1f54e
            | 0x1f550..=0x1f567
            | 0x1f56f..=0x1f570
            | 0x1f573..=0x1f57a
            | 0x1f587
            | 0x1f58a..=0x1f58d
            | 0x1f590
            | 0x1f595..=0x1f596
            | 0x1f5a4..=0x1f5a5
            | 0x1f5a8
            | 0x1f5b1..=0x1f5b2
            | 0x1f5bc
            | 0x1f5c2..=0x1f5c4
            | 0x1f5d1..=0x1f5d3
            | 0x1f5dc..=0x1f5de
            | 0x1f5e1
            | 0x1f5e3
            | 0x1f5e8
            | 0x1f5ef
            | 0x1f5f3
            | 0x1f5fa..=0x1f64f
            | 0x1f680..=0x1f6c5
            | 0x1f6cb..=0x1f6d2
            | 0x1f6d5..=0x1f6d8
            | 0x1f6dc..=0x1f6e5
            | 0x1f6e9
            | 0x1f6eb..=0x1f6ec
            | 0x1f6f0
            | 0x1f6f3..=0x1f6fc
            | 0x1f7e0..=0x1f7eb
            | 0x1f7f0
            | 0x1f90c..=0x1f93a
            | 0x1f93c..=0x1f945
            | 0x1f947..=0x1f9ff
            | 0x1fa70..=0x1fa7c
            | 0x1fa80..=0x1fa8a
            | 0x1fa8e..=0x1fac6
            | 0x1fac8
            | 0x1facd..=0x1fadc
            | 0x1fadf..=0x1faea
            | 0x1faef..=0x1faf8
    )
}

// Emoji_Modifier_Base property.
fn modifier_base(c: char) -> bool {
    matches!(c as u32,
        0x261d
            | 0x26f9
            | 0x270a..=0x270d
            | 0x1f385
            | 0x1f3c2..=0x1f3c4
            | 0x1f3c7
            | 0x1f3ca..=0x1f3cc
            | 0x1f442..=0x1f443
            | 0x1f446..=0x1f450
            | 0x1f466..=0x1f478
            | 0x1f47c
            | 0x1f481..=0x1f483
            | 0x1f485..=0x1f487
            | 0x1f48f
            | 0x1f491
            | 0x1f4aa
            | 0x1f574..=0x1f575
            | 0x1f57a
            | 0x1f590
            | 0x1f595..=0x1f596
            | 0x1f645..=0x1f647
            | 0x1f64b..=0x1f64f
            | 0x1f6a3
            | 0x1f6b4..=0x1f6b6
            | 0x1f6c0
            | 0x1f6cc
            | 0x1f90c
            | 0x1f90f
            | 0x1f918..=0x1f91f
            | 0x1f926
            | 0x1f930..=0x1f939
            | 0x1f93c..=0x1f93e
            | 0x1f977
            | 0x1f9b5..=0x1f9b6
            | 0x1f9b8..=0x1f9b9
            | 0x1f9bb
            | 0x1f9cd..=0x1f9cf
            | 0x1f9d1..=0x1f9dd
            | 0x1fac3..=0x1fac5
            | 0x1faf0..=0x1faf8
    )
}
