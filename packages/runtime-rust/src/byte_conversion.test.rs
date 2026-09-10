use super::*;

#[test]
fn u8_conversion_matches_truncation_modulo_across_binary64() {
    fn reference(value: f64) -> u8 {
        if !value.is_finite() { return 0; }
        value.trunc().rem_euclid(256.0) as u8
    }
    let check = |value: f64| {
        assert_eq!(u8::from_number(value), reference(value), "bits={:016x}", value.to_bits());
    };
    for exponent in 0_u64..2048 {
        for sign in [0, 1_u64 << 63] {
            for mantissa in [0, 1, 0x0007_ffff_ffff_ffff, 0x0008_0000_0000_0000,
                0x000f_ffff_ffff_fffe, 0x000f_ffff_ffff_ffff] {
                check(f64::from_bits(sign | (exponent << 52) | mantissa));
            }
        }
    }
    let mut seed = 0xa123_4567_89ab_cdef_u64;
    for _ in 0..1_000_000 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        check(f64::from_bits(seed));
    }
    for integer in -4096..4096 {
        for fraction in [-0.75, -0.25, 0.0, 0.25, 0.75] {
            check(f64::from(integer) + fraction);
        }
    }
    // No binary64 truncates to i64::MAX: the adjacent representable values
    // straddle it. Both saturation boundaries must keep their modulo result.
    for boundary in [i64::MIN as f64, i64::MAX as f64, 2_f64.powi(60)] {
        for delta in -16..=16 {
            check(f64::from_bits(boundary.to_bits().wrapping_add_signed(delta)));
        }
    }
}
