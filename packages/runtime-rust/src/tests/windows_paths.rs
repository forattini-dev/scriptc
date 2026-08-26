#[test]
fn windows_path_join_handles_drives_unc_and_dot_segments() {
    let join = |parts: &[&str]| {
        path_win32_join(&array_new(parts.iter().map(|part| string(part)).collect()))
    };
    for (parts, expected) in [
        (
            &["C:\\ProgramData", "portless", "service"][..],
            "C:\\ProgramData\\portless\\service",
        ),
        (&["a", "..", "b", ".", "c"][..], "b\\c"),
        (&["..", "..", "up"][..], "..\\..\\up"),
        (&["C:\\", "windows\\..\\temp\\", ""][..], "C:\\temp\\"),
        (
            &["\\\\server", "share", "folder"][..],
            "\\\\server\\share\\folder",
        ),
        (
            &["\\\\server\\share", "file.txt"][..],
            "\\\\server\\share\\file.txt",
        ),
        (&["/", "/foo", "bar/"][..], "\\foo\\bar\\"),
        (&["C:", "file.txt"][..], "C:\\file.txt"),
        (&[""][..], "."),
        (&["", ""][..], "."),
        (&[".", "x"][..], "x"),
    ] {
        assert_eq!(join(parts).as_ref(), expected);
    }
}

#[test]
fn windows_path_family_matches_node_drive_and_unc_rules() {
    let resolve = |parts: &[&str]| {
        path_win32_resolve(&array_new(parts.iter().map(|part| string(part)).collect()))
    };
    assert_eq!(path_win32_normalize(&string("C:/temp//foo/../bar/")).as_ref(), "C:\\temp\\bar\\");
    assert_eq!(resolve(&["C:\\base\\dir", "..\\file.txt"]).as_ref(), "C:\\base\\file.txt");
    assert_eq!(resolve(&["\\\\server\\share\\base", "..\\file"]).as_ref(), "\\\\server\\share\\file");
    assert!(path_win32_is_absolute(&string("C:\\base")));
    assert!(!path_win32_is_absolute(&string("C:base")));
    assert_eq!(path_win32_relative(&string("C:\\a\\b"), &string("C:\\a\\c\\d")).as_ref(), "..\\c\\d");
    assert_eq!(path_win32_dirname(&string("\\\\server\\share\\a\\b.txt")).as_ref(), "\\\\server\\share\\a");
    assert_eq!(path_win32_basename(&string("C:\\a\\file.txt"), &string(".txt")).as_ref(), "file");
    assert_eq!(path_win32_extname(&string("C:\\a\\file.txt")).as_ref(), ".txt");
    assert_eq!(path_win32_to_namespaced_path(&string("C:\\a\\b")).as_ref(), "\\\\?\\C:\\a\\b");
}

#[test]
fn windows_path_family_matches_the_committed_node_oracle() {
    fn decode(field: &str) -> JsString {
        if field == "-" {
            return empty_string();
        }
        let bytes = field
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let digit = |byte: u8| match byte {
                    b'0'..=b'9' => byte - b'0',
                    b'a'..=b'f' => byte - b'a' + 10,
                    b'A'..=b'F' => byte - b'A' + 10,
                    _ => panic!("scriptc: invalid path oracle hex"),
                };
                digit(pair[0]) * 16 + digit(pair[1])
            })
            .collect::<Vec<_>>();
        Rc::from(String::from_utf8(bytes).expect("scriptc: path oracle must be UTF-8"))
    }

    let oracle = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/test/path-cases.txt"),
    )
    .expect("the committed path oracle must be readable");
    let mut failures = Vec::new();
    let mut total = 0usize;
    for line in oracle.lines() {
        let fields = line.split('\t').collect::<Vec<_>>();
        let op = fields[0];
        let args = fields[1..fields.len() - 1]
            .iter()
            .map(|field| decode(field))
            .collect::<Vec<_>>();
        let expected = decode(fields[fields.len() - 1]);
        let got = match op {
            "normalize" => path_win32_normalize(&args[0]),
            "dirname" => path_win32_dirname(&args[0]),
            "basename" => path_win32_basename(&args[0], &empty_string()),
            "basenameSuffix" => path_win32_basename(&args[0], &args[1]),
            "extname" => path_win32_extname(&args[0]),
            "isAbsolute" => string(if path_win32_is_absolute(&args[0]) {
                "true"
            } else {
                "false"
            }),
            "toNamespacedPath" => windows_namespaced_path(&args[0], b"\\"),
            "relative" => relative_windows_path(&args[0], &args[1], b"\\"),
            name if name.starts_with("join") => path_win32_join(&array_new(args.clone())),
            name if name.starts_with("resolve") => {
                resolve_windows_path(&array_new(args.clone()), b"\\")
            }
            _ => panic!("scriptc: unknown path oracle operation {op}"),
        };
        total += 1;
        if got != expected && failures.len() < 20 {
            failures.push(format!("{op}({args:?}): expected {expected:?}, got {got:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {total} path oracle cases failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(total, 38_214);
}
