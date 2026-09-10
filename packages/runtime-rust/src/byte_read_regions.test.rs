use super::*;

#[test]
fn shared_input_slices_preserve_aliases_offsets_and_bounds() {
    let owner = bytes_from_elements(vec![10_u8, 20, 30, 40]);
    let left = bytes_slice(&owner, 1.0, 3.0, true);
    let right = bytes_slice(&owner, 0.0, 2.0, true);
    bytes_with_read_slice(&left, |a| {
        bytes_with_read_slice(&right, |b| {
            assert!(a.is_some() && b.is_some());
            assert_eq!(bytes_read_region_len(a, &left), 2.0);
            assert_eq!(bytes_read_region_get(a, &left, -0.0), 20.0);
            assert_eq!(bytes_read_region_get_usize(b, &right, 1), 20.0);
            for index in [-1.0, 0.5, 2.0, f64::NAN, f64::INFINITY] {
                assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    bytes_read_region_get(a, &left, index)
                })).is_err());
            }
        });
    });
    bytes_set(&owner, 1.0, 99.0);
    assert_eq!(bytes_get(&left, 0.0), 99.0);
}

#[test]
fn backed_input_views_use_original_access_without_copying() {
    let words = bytes_from_elements(vec![0x04030201_u32, 0x08070605]);
    let view = data_view_new(&words, 1.0, true, 4.0);
    bytes_with_read_slice(&view, |slice| {
        assert!(slice.is_none());
        assert_eq!(bytes_read_region_len(slice, &view), 4.0);
        for index in 0..4 {
            assert_eq!(bytes_read_region_get_usize(slice, &view, index), bytes_get(&view, index as f64));
            assert_eq!(bytes_read_region_get(slice, &view, index as f64), bytes_get(&view, index as f64));
        }
    });
}

#[test]
fn unwinding_releases_read_input_storage() {
    let input = bytes_from_elements(vec![1_u8, 2]);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        bytes_with_read_slice(&input, |slice| bytes_read_region_get(slice, &input, 2.0))
    })).is_err());
    bytes_set(&input, 0.0, 3.0);
    assert_eq!(bytes_get(&input, 0.0), 3.0);
}

#[test]
fn optional_input_calls_body_once_for_direct_missing_and_backed_storage() {
    let direct = bytes_from_elements(vec![1_u8, 2]);
    let words = bytes_from_elements(vec![0x04030201_u32]);
    let backed = data_view_new(&words, 0.0, true, 4.0);
    for (input, expected) in [(Some(&direct), true), (None, false), (Some(&backed), false)] {
        let mut calls = 0;
        let result = bytes_with_optional_read_slice(input, |slice| {
            calls += 1;
            assert_eq!(slice.is_some(), expected);
            42
        });
        assert_eq!((calls, result), (1, 42));
    }
}

#[test]
fn optional_input_releases_storage_after_unwind() {
    let input = bytes_from_elements(vec![1_u8, 2]);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        bytes_with_optional_read_slice(Some(&input), |slice| {
            bytes_region_get(slice.unwrap(), 2.0)
        })
    })).is_err());
    bytes_set(&input, 0.0, 7.0);
    assert_eq!(bytes_get(&input, 0.0), 7.0);
}


#[test]
fn integer_byte_reads_preserve_all_values_offsets_and_checked_bounds() {
    let bytes: Vec<u8> = (0..=255).collect();
    for (index, value) in bytes.iter().enumerate() {
        assert_eq!(bytes_region_get_u8_integer(&bytes, index), i64::from(*value));
    }
    assert_eq!(bytes_region_get_u8_integer(&bytes[128..], 127), 255);
    for index in [256, usize::MAX] {
        assert!(std::panic::catch_unwind(|| bytes_region_get_u8_integer(&bytes, index)).is_err());
    }
    assert!(std::panic::catch_unwind(|| bytes_region_get_u8_integer(&[], 0)).is_err());
}


#[test]
fn integer_byte_stores_match_number_conversion_and_check_bounds() {
    let mut bytes = [0_u8; 3];
    for value in [-9_007_199_254_740_991_i64, -4_294_967_297, -257, -256, -1,
        0, 1, 255, 256, 257, 4_294_967_297, 9_007_199_254_740_991] {
        bytes_region_set_u8_integer(&mut bytes[1..2], 0, value);
        assert_eq!(bytes[1], <u8 as ByteElement>::from_number(value as f64));
        assert_eq!((bytes[0], bytes[2]), (0, 0));
    }
    for index in [3, usize::MAX] {
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            bytes_region_set_u8_integer(&mut bytes, index, 7)
        })).is_err());
    }
}
