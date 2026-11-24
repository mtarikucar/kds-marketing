//! The bundled fonts: two variable families under the SIL Open Font License 1.1 (`fonts/`, with
//! their licence texts), instanced at the weights the templates use.
use harfrust::font::{Font, Variation};
use harfrust::{GlyphId, Tag};
use jt_studio::compose::FontFamily;

static BRICOLAGE_GROTESQUE: &[u8] =
    include_bytes!("../fonts/BricolageGrotesque[opsz,wdth,wght].ttf");
static FIGTREE: &[u8] = include_bytes!("../fonts/Figtree[wght].ttf");

/// The weights instanced for each family.
const WEIGHTS: [u16; 4] = [500, 600, 700, 800];

/// One family at one weight, with its vertical metrics in font units.
pub(crate) struct Instance {
    pub family: FontFamily,
    pub weight: u16,
    pub font: Font,
    pub units_per_em: f32,
    pub ascender: f32,
    /// Below the baseline, positive.
    pub descender: f32,
}

/// Every bundled family at every weight a template uses, parsed once.
pub(crate) struct FontSet {
    instances: Vec<Instance>,
}

fn bytes(family: FontFamily) -> &'static [u8] {
    match family {
        FontFamily::BricolageGrotesque => BRICOLAGE_GROTESQUE,
        FontFamily::Figtree => FIGTREE,
    }
}

impl FontSet {
    /// Parses the bundled fonts. They are part of the binary, so a font that does not parse is a
    /// build defect: `None` then, and the renderer refuses every job.
    pub fn load() -> Option<FontSet> {
        let mut instances = Vec::new();
        for family in FontFamily::ALL {
            let base = Font::new(bytes(family), 0)?;
            for weight in WEIGHTS {
                let mut variations = vec![Variation::new(Tag::new(b"wght"), f32::from(weight))];
                if family == FontFamily::BricolageGrotesque {
                    // The display optical size and the normal width, the family's own default.
                    variations.push(Variation::new(Tag::new(b"opsz"), 96.0));
                    variations.push(Variation::new(Tag::new(b"wdth"), 100.0));
                }
                let font = base.instance_builder().variations(variations).build();
                let line = font.metrics().h_line()?;
                instances.push(Instance {
                    family,
                    weight,
                    units_per_em: f32::from(font.units_per_em()),
                    ascender: line.ascender.to_f32(),
                    descender: -line.descender.to_f32(),
                    font,
                });
            }
        }
        Some(FontSet { instances })
    }

    /// The instance of `family` nearest `weight`.
    pub fn instance(&self, family: FontFamily, weight: u16) -> usize {
        self.instances
            .iter()
            .enumerate()
            .filter(|(_, i)| i.family == family)
            .min_by_key(|(_, i)| i.weight.abs_diff(weight))
            .map_or(0, |(at, _)| at)
    }

    pub fn get(&self, at: usize) -> &Instance {
        &self.instances[at]
    }

    /// The glyph of `c` in the instance at `at`.
    pub fn glyph(&self, at: usize, c: char) -> Option<GlyphId> {
        self.instances[at].font.charmap().map_unicode(c)
    }

    /// Whether `family` draws `c`.
    pub fn covers(&self, family: FontFamily, c: char) -> bool {
        self.glyph(self.instance(family, 500), c).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jt_studio::compose::{FontRole, SlotKind, templates};

    /// The Turkish letters, the digits and the punctuation a slot's text may carry.
    const TEXT: &str = "AaBbCcÇçDdEeFfGgĞğHhIıİiJjKkLlMmNnOoÖöPpRrSsŞşTtUuÜüVvYyZzÂâÎîÛûQqWwXx\
                        0123456789 .,;:!?'\"’‘“”-–—()/&%+·…@#";

    #[test]
    fn every_bundled_font_parses() {
        let fonts = FontSet::load().expect("fonts");
        for family in FontFamily::ALL {
            for weight in WEIGHTS {
                let at = fonts.instance(family, weight);
                assert_eq!(fonts.get(at).weight, weight);
            }
        }
    }

    /// Every font a slot is set in draws what the slot may receive, with per-glyph fallback to
    /// the other family: the Turkish set, digits and punctuation in each family on its own, and
    /// ₺ (which Figtree lacks) in a price slot's font, Bricolage Grotesque, or through fallback.
    #[test]
    fn fonts_cover_what_their_slots_take() {
        let fonts = FontSet::load().expect("fonts");
        for family in FontFamily::ALL {
            for c in TEXT.chars() {
                assert!(fonts.covers(family, c), "{family:?} lacks {c:?}");
            }
        }
        assert!(fonts.covers(FontFamily::BricolageGrotesque, '₺'));
        assert!(
            FontFamily::ALL.iter().any(|f| fonts.covers(*f, '₺')),
            "no bundled family draws ₺"
        );
        for t in templates() {
            for s in &t.slots {
                if s.kind == SlotKind::Price {
                    let style = s.style.expect("price style");
                    // A price is set in the workspace's heading font; whichever family that is,
                    // ₺ is drawn by it or by the fallback family.
                    assert_eq!(style.font, FontRole::Heading);
                }
            }
        }
    }
}
