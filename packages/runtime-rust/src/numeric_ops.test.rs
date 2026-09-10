#[test]
fn integer_coercion_matches_modulo_over_binary64_patterns() {
    // Independent arithmetic definition; the optimized implementation extracts
    // IEEE-754 bits. Include NaNs, subnormals, signed zeros and every exponent.
    fn reference(value: f64) -> i32 {
        if !value.is_finite() { return 0; }
        let modulo = value.trunc().rem_euclid(4_294_967_296.0);
        if modulo >= 2_147_483_648.0 {
            (modulo - 4_294_967_296.0) as i32
        } else { modulo as i32 }
    }
    let check = |bits| {
        let value = f64::from_bits(bits);
        let expected = reference(value);
        assert_eq!(to_int32(value), expected, "bits={bits:016x}");
        assert_eq!(to_uint32(value), expected as u32, "bits={bits:016x}");
    };
    for exponent in 0_u64..2048 {
        for sign in [0, 1_u64 << 63] {
            for mantissa in [0, 1, 0x0007_ffff_ffff_ffff, 0x0008_0000_0000_0000,
                0x000f_ffff_ffff_fffe, 0x000f_ffff_ffff_ffff] {
                check(sign | (exponent << 52) | mantissa);
            }
        }
    }
    let mut seed = 0xa123_4567_89ab_cdef_u64;
    for _ in 0..100_000 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        check(seed);
    }
}
