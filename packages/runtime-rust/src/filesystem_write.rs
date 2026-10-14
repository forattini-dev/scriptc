/// libuv passes integral negative offsets through on Windows: -2 names the
/// current position without advancing it, and other values below -2 fail.
fn normalized_write_position(position: f64) -> f64 {
    let minimum = if cfg!(windows) {
        -9_007_199_254_740_991.0
    } else {
        0.0
    };
    if position.is_finite()
        && position.fract() == 0.0
        && (minimum..=9_007_199_254_740_991.0).contains(&position)
    {
        position
    } else {
        -1.0
    }
}

fn with_write_position<T>(
    file: &mut std::fs::File,
    position: f64,
    action: impl FnOnce(&mut std::fs::File) -> std::io::Result<T>,
) -> std::io::Result<T> {
    if cfg!(windows) && position < -2.0 {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    if cfg!(windows) && position == -2.0 {
        use std::io::{Seek, SeekFrom};
        let current = file.stream_position()?;
        let result = action(file);
        let restored = file.seek(SeekFrom::Start(current));
        return match result {
            Err(error) => Err(error),
            Ok(value) => restored.map(|_| value),
        };
    }
    with_preserved_position(file, position, action)
}

pub fn fs_write_sync(fd: f64, bytes: &JsBytes<u8>, offset: f64, length: f64, position: f64) -> f64 {
    let byte_length = bytes.with(|data| data.length);
    let (offset, length) = validate_write_window(byte_length, offset, length);
    validate_write_fd(fd);
    let input = bytes.with(|data| {
        data.storage.borrow()[data.offset + offset..data.offset + offset + length].to_vec()
    });
    let position = normalized_write_position(position);
    use std::io::Write;
    with_open_file(fd, "write", |file| {
        with_write_position(file, position, |file| file.write(&input))
    }) as f64
}

pub fn fs_write_str_sync(fd: f64, text: &JsString, position: f64, _encoding: &JsString) -> f64 {
    validate_write_fd(fd);
    let position = normalized_write_position(position);
    use std::io::Write;
    with_open_file(fd, "write", |file| {
        with_write_position(file, position, |file| file.write(text.as_bytes()))
    }) as f64
}
