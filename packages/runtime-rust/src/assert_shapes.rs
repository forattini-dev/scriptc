enum AssertShapeExpected {
    String(JsString),
    Regex { matched: bool, rendered: JsString },
}

struct AssertShapeState {
    error: JsError,
    slots: [Option<AssertShapeExpected>; 3],
}

thread_local! {
    static ASSERT_SHAPE: RefCell<Option<AssertShapeState>> = const { RefCell::new(None) };
}

fn assert_shape_index(key: f64) -> usize {
    let index = key as usize;
    assert!(index < 3, "scriptc: invalid assertion shape slot");
    index
}

fn assert_shape_actual(error: &JsError, key: usize) -> Option<JsString> {
    match key {
        0 => error_code(error),
        1 => Some(error_message(error)),
        _ => Some(error_name(error)),
    }
}

pub fn assert_shape_begin(error: &JsError) {
    ASSERT_SHAPE.with(|shape| {
        *shape.borrow_mut() = Some(AssertShapeState {
            error: error.clone(),
            slots: std::array::from_fn(|_| None),
        });
    });
}

pub fn assert_shape_string(key: f64, value: &JsString) {
    let index = assert_shape_index(key);
    ASSERT_SHAPE.with(|shape| {
        let mut shape = shape.borrow_mut();
        let state = shape
            .as_mut()
            .expect("scriptc: assertion shape slot without begin");
        state.slots[index] = Some(AssertShapeExpected::String(value.clone()));
    });
}

pub fn assert_shape_regex(key: f64, regex: &JsRegex) {
    let index = assert_shape_index(key);
    ASSERT_SHAPE.with(|shape| {
        let mut shape = shape.borrow_mut();
        let state = shape
            .as_mut()
            .expect("scriptc: assertion shape slot without begin");
        let matched = assert_shape_actual(&state.error, index)
            .is_some_and(|actual| regex_hits(regex, &actual));
        let rendered = string(&format!(
            "/{}/{}",
            regex_source(regex),
            regex_flags(regex)
        ));
        state.slots[index] = Some(AssertShapeExpected::Regex { matched, rendered });
    });
}

fn assert_shape_matches(state: &AssertShapeState) -> bool {
    state.slots.iter().enumerate().all(|(key, expected)| {
        let Some(expected) = expected else { return true };
        let Some(actual) = assert_shape_actual(&state.error, key) else {
            return false;
        };
        match expected {
            AssertShapeExpected::String(expected) => actual.as_ref() == expected.as_ref(),
            AssertShapeExpected::Regex { matched, .. } => *matched,
        }
    })
}

fn assert_shape_line(key: usize, value: &str, inspect: bool, last: bool) -> String {
    let key_name = ["code", "message", "name"][key];
    format!(
        "  {key_name}: {}{}",
        if inspect {
            assert_inspect_string(value)
        } else {
            value.to_owned()
        },
        if last { "" } else { "," },
    )
}

fn assert_shape_lines(state: &AssertShapeState) -> (Vec<String>, Vec<String>) {
    let expected_keys = state
        .slots
        .iter()
        .enumerate()
        .filter_map(|(key, value)| value.as_ref().map(|_| key))
        .collect::<Vec<_>>();
    let actual_keys = expected_keys
        .iter()
        .copied()
        .filter(|key| assert_shape_actual(&state.error, *key).is_some())
        .collect::<Vec<_>>();
    let actual = if actual_keys.is_empty() {
        vec!["Comparison {}".to_owned()]
    } else {
        let mut lines = vec!["Comparison {".to_owned()];
        for (index, key) in actual_keys.iter().enumerate() {
            let value = assert_shape_actual(&state.error, *key)
                .expect("scriptc: present assertion shape key disappeared");
            lines.push(assert_shape_line(
                *key,
                &value,
                true,
                index + 1 == actual_keys.len(),
            ));
        }
        lines.push("}".to_owned());
        lines
    };
    let mut expected = vec!["Comparison {".to_owned()];
    for (index, key) in expected_keys.iter().enumerate() {
        let slot = state.slots[*key]
            .as_ref()
            .expect("scriptc: expected assertion shape key disappeared");
        let (value, inspect) = match slot {
            AssertShapeExpected::String(value) => (value.clone(), true),
            AssertShapeExpected::Regex { matched: true, .. } => (
                assert_shape_actual(&state.error, *key)
                    .expect("scriptc: matched assertion regex has no actual value"),
                true,
            ),
            AssertShapeExpected::Regex { rendered, .. } => (rendered.clone(), false),
        };
        expected.push(assert_shape_line(
            *key,
            &value,
            inspect,
            index + 1 == expected_keys.len(),
        ));
    }
    expected.push("}".to_owned());
    (actual, expected)
}

fn assert_shape_diff(actual: &[String], expected: &[String]) -> String {
    let mut lengths = vec![vec![0_usize; expected.len() + 1]; actual.len() + 1];
    for actual_index in (0..actual.len()).rev() {
        for expected_index in (0..expected.len()).rev() {
            lengths[actual_index][expected_index] = if actual[actual_index] == expected[expected_index] {
                lengths[actual_index + 1][expected_index + 1] + 1
            } else {
                lengths[actual_index + 1][expected_index]
                    .max(lengths[actual_index][expected_index + 1])
            };
        }
    }
    let mut output =
        "Expected values to be strictly deep-equal:\n+ actual - expected\n".to_owned();
    let (mut actual_index, mut expected_index) = (0, 0);
    while actual_index < actual.len() && expected_index < expected.len() {
        if actual[actual_index] == expected[expected_index] {
            output.push_str("\n  ");
            output.push_str(&actual[actual_index]);
            actual_index += 1;
            expected_index += 1;
        } else if lengths[actual_index + 1][expected_index]
            >= lengths[actual_index][expected_index + 1]
        {
            output.push_str("\n+ ");
            output.push_str(&actual[actual_index]);
            actual_index += 1;
        } else {
            output.push_str("\n- ");
            output.push_str(&expected[expected_index]);
            expected_index += 1;
        }
    }
    for line in &actual[actual_index..] {
        output.push_str("\n+ ");
        output.push_str(line);
    }
    for line in &expected[expected_index..] {
        output.push_str("\n- ");
        output.push_str(line);
    }
    output.push('\n');
    output
}

pub fn assert_shape_end(message: &JsString, has_message: bool) {
    let state = ASSERT_SHAPE.with(|shape| {
        shape
            .borrow_mut()
            .take()
            .expect("scriptc: assertion shape end without begin")
    });
    if assert_shape_matches(&state) {
        return;
    }
    if has_message {
        throw_assertion_error(message.to_string());
    }
    let (actual, expected) = assert_shape_lines(&state);
    throw_assertion_error(assert_shape_diff(&actual, &expected))
}
