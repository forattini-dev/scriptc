use super::*;

#[test]
fn bulk_set_copies_between_direct_and_backed_views_with_offsets() {
    let owner = bytes_from_elements(vec![0_u32; 3]);
    let all = data_view_new(&owner, 0.0, false, 0.0);
    let target = data_view_new(&owner, 2.0, true, 8.0);
    let source = bytes_from_elements(vec![99_u8, 10, 20, 30, 99]);
    let input = bytes_slice(&source, 1.0, 4.0, true);
    bytes_set_from(&target, &input, 2.9);
    assert_eq!(bytes_values(&all), [0, 0, 0, 0, 10, 20, 30, 0, 0, 0, 0, 0]);
    let output = bytes_from_elements(vec![7_u8; 7]);
    let backed_input = bytes_slice(&target, 2.0, 5.0, true);
    bytes_set_from(&output, &backed_input, 1.0);
    assert_eq!(bytes_values(&output), [7, 10, 20, 30, 7, 7, 7]);
    bytes_set_from(&target, &backed_input, 5.0);
    assert_eq!(bytes_values(&target), [0, 0, 10, 20, 30, 10, 20, 30]);
    assert_eq!(bytes_join(&target, &string(":")), string("0:0:10:20:30:10:20:30"));
}

#[test]
fn bulk_set_snapshots_overlapping_backed_views_in_both_directions() {
    let words = bytes_from_elements(vec![0_u32; 2]);
    let view = data_view_new(&words, 0.0, false, 0.0);
    let seed = bytes_from_elements(vec![1_u8, 2, 3, 4, 5, 6, 7, 8]);
    bytes_set_from(&view, &seed, 0.0);
    let prefix = bytes_slice(&view, 0.0, 6.0, true);
    bytes_set_from(&view, &prefix, 2.0);
    assert_eq!(bytes_values(&view), [1, 2, 1, 2, 3, 4, 5, 6]);
    let suffix = bytes_slice(&view, 2.0, 8.0, true);
    bytes_set_from(&view, &suffix, 0.0);
    assert_eq!(bytes_values(&view), [1, 2, 3, 4, 5, 6, 5, 6]);
    bytes_set_from(&view, &view, -0.0);
    assert_eq!(bytes_values(&view), [1, 2, 3, 4, 5, 6, 5, 6]);
}

#[test]
fn bulk_set_checks_view_bounds_before_any_write_and_accepts_empty_copy() {
    init();
    let owner = bytes_from_elements(vec![0_u32; 2]);
    let view = data_view_new(&owner, 2.0, true, 3.0);
    let source = bytes_from_elements(vec![1_u8, 2]);
    for offset in [-1.0, f64::INFINITY, f64::NEG_INFINITY, 2.0, 4.0] {
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            bytes_set_from(&view, &source, offset);
        })).expect_err("invalid offset must throw");
        let caught = caught_from_panic(panic);
        assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
        assert_eq!(bytes_values(&view), [0, 0, 0]);
    }
    let empty = bytes_from_elements(Vec::<u8>::new());
    bytes_set_from(&view, &empty, 3.0);
    bytes_set_from(&view, &source, f64::NAN);
    assert_eq!(bytes_values(&view), [1, 2, 0]);
    drop((owner, view, source, empty));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn bulk_set_direct_storage_keeps_float_bits_and_overlap() {
    let nan = f64::from_bits(0x7ff8_0000_0000_1234);
    let floats = bytes_from_elements(vec![nan, -0.0_f64, 5.0]);
    let source = bytes_slice(&floats, 0.0, 2.0, true);
    bytes_set_from(&floats, &source, 1.0);
    let result = bytes_values(&floats);
    assert_eq!(result[1].to_bits(), nan.to_bits());
    assert_eq!(result[2].to_bits(), (-0.0_f64).to_bits());
}
