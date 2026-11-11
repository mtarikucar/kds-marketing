//! Phone numbers in outputs: never shown whole (spec §10, "masking").

/// `e164` (`+905321234567`) as every output shows it: the country code, the first digit of the
/// national number and its last two, the rest starred: `+90 5** *** ** 67`. A Turkish number
/// (`+90` and ten national digits) keeps its usual grouping; any other keeps only its first two and
/// last two digits. Something that is not `+` and 8 to 15 digits is starred whole.
pub fn mask_e164(e164: &str) -> String {
    let digits: Vec<char> = match e164.strip_prefix('+') {
        Some(rest)
            if (8..=15).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_digit()) =>
        {
            rest.chars().collect()
        }
        _ => return "***".to_owned(),
    };
    if digits.len() == 12 && digits[0] == '9' && digits[1] == '0' {
        let national = &digits[2..];
        return format!(
            "+90 {}** *** ** {}{}",
            national[0], national[8], national[9]
        );
    }
    let n = digits.len();
    let mut out = String::from("+");
    for (i, d) in digits.iter().enumerate() {
        out.push(if i < 2 || i >= n - 2 { *d } else { '*' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_turkish_and_other_numbers() {
        assert_eq!(mask_e164("+905321234567"), "+90 5** *** ** 67");
        assert_eq!(mask_e164("+4915112345678"), "+49*********78");
        for bad in ["905321234567", "+90 532 123", "+90abc", "", "+1234567"] {
            assert_eq!(mask_e164(bad), "***", "{bad}");
        }
        assert!(!mask_e164("+905321234567").contains("123456"));
    }
}
