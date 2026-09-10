use super::*;

#[test]
fn direct_input_and_offset_views_are_borrowed() {
    let input = bytes_from_elements(vec![11_u8, 22, 33, 44, 55]);
    let view = bytes_slice(&input, 1.0, 4.0, true);
    for bytes in [&input, &view] {
        bytes.with(|data| {
            let storage = data.storage.borrow();
            let expected = &storage[data.offset..data.offset + data.length];
            zlib_with_input(bytes, |actual| {
                assert_eq!(actual, expected);
                assert!(std::ptr::eq(actual.as_ptr(), expected.as_ptr()), "compression must borrow direct input instead of copying it");
            });
        });
    }
}

#[test]
fn compression_preserves_views_and_observes_alias_writes() {
    let direct = bytes_from_elements(vec![99_u8, 1, 2, 3, 4, 5, 6, 88]);
    let words = bytes_from_elements(vec![0x0403_0201_u32, 0x0807_0605]);
    let views = [
        bytes_slice(&direct, 1.0, 7.0, true),
        data_view_new(&direct, 2.0, true, 4.0),
        data_view_new(&words, 1.0, true, 6.0),
        bytes_slice(&direct, 4.0, 4.0, true),
    ];
    for round in 0..2 {
        for view in &views {
            let source = bytes_u8_values(view);
            let plain = bytes_from_elements(source.clone());
            for level in [-1.0, 0.0, 1.0, 9.0] {
                let zipped = zlib_deflate_sync_level(view, level);
                assert_eq!(bytes_u8_values(&zipped), bytes_u8_values(&zlib_deflate_sync_level(&plain, level)));
                assert_eq!(bytes_u8_values(&zlib_inflate_sync(&zipped)), source);
            }
            assert_eq!(bytes_u8_values(&zlib_deflate_sync(view)), bytes_u8_values(&zlib_deflate_sync(&plain)));
            assert_eq!(bytes_u8_values(&zlib_deflate_raw_sync(view)), bytes_u8_values(&zlib_deflate_raw_sync(&plain)));
            assert_eq!(bytes_u8_values(&zlib_gzip_sync(view)), bytes_u8_values(&zlib_gzip_sync(&plain)));
            assert_eq!(bytes_u8_values(view), source, "compression changed input");
        }
        bytes_set(&direct, 3.0, 40.0 + f64::from(round));
        bytes_set(&words, 0.0, f64::from(0x4433_2211_u32));
    }
}

#[test]
fn input_borrow_is_released_when_the_operation_unwinds() {
    let input = bytes_from_elements(vec![1_u8, 2, 3]);
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        zlib_with_input(&input, |_| panic!("probe unwind"));
    }));
    assert!(caught.is_err());
    bytes_set(&input, 1.0, 9.0);
    assert_eq!(bytes_u8_values(&input), vec![1, 9, 3]);
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        zlib_deflate_sync_level(&input, 10.0);
    }));
    assert!(caught.is_err());
    bytes_set(&input, 0.0, 7.0);
    assert_eq!(bytes_u8_values(&input), vec![7, 9, 3]);
}
