#[derive(Clone, Copy)]
struct AssertDiffLine<'a> {
    operation: i8,
    line: &'a str,
}

fn assert_lines_equal(left: &str, right: &str, comma: bool) -> bool {
    left == right
        || (comma
            && (left.strip_suffix(',') == Some(right) || right.strip_suffix(',') == Some(left)))
}

fn assert_myers_diff<'a>(
    actual: &[&'a str],
    expected: &[&'a str],
    comma: bool,
) -> Option<Vec<AssertDiffLine<'a>>> {
    let max = actual.len() + expected.len();
    if max == 0 || max > 4096 {
        return None;
    }
    let width = 2 * max + 1;
    let mut frontier = vec![0_isize; width];
    let mut trace = Vec::with_capacity(max + 1);
    let mut found_level = None;
    'levels: for depth in 0..=max {
        trace.push(frontier.clone());
        for diagonal in (-(depth as isize)..=depth as isize).step_by(2) {
            let offset = (diagonal + max as isize) as usize;
            let mut x = if diagonal == -(depth as isize)
                || (diagonal != depth as isize && frontier[offset - 1] < frontier[offset + 1])
            {
                frontier[offset + 1]
            } else {
                frontier[offset - 1] + 1
            };
            let mut y = x - diagonal;
            while x < actual.len() as isize
                && y < expected.len() as isize
                && assert_lines_equal(actual[x as usize], expected[y as usize], comma)
            {
                x += 1;
                y += 1;
            }
            frontier[offset] = x;
            if x >= actual.len() as isize && y >= expected.len() as isize {
                found_level = Some(depth);
                break 'levels;
            }
        }
    }

    let found_level = found_level?;
    let mut result = Vec::with_capacity(max + 1);
    let mut x = actual.len() as isize;
    let mut y = expected.len() as isize;
    for level in (0..=found_level).rev() {
        let frontier = &trace[level];
        let diagonal = x - y;
        let level = level as isize;
        let offset = (diagonal + max as isize) as usize;
        let previous_diagonal = if diagonal == -level
            || (diagonal != level && frontier[offset - 1] < frontier[offset + 1])
        {
            diagonal + 1
        } else {
            diagonal - 1
        };
        let previous_x = frontier[(previous_diagonal + max as isize) as usize];
        let previous_y = previous_x - previous_diagonal;
        while x > previous_x && y > previous_y {
            let actual_line = actual[(x - 1) as usize];
            let line = if comma && !actual_line.ends_with(',') {
                expected[(y - 1) as usize]
            } else {
                actual_line
            };
            result.push(AssertDiffLine { operation: 0, line });
            x -= 1;
            y -= 1;
        }
        if level > 0 {
            if x > previous_x {
                x -= 1;
                result.push(AssertDiffLine {
                    operation: 1,
                    line: actual[x as usize],
                });
            } else {
                y -= 1;
                result.push(AssertDiffLine {
                    operation: -1,
                    line: expected[y as usize],
                });
            }
        }
    }
    Some(result)
}

fn assert_diff_line(output: &mut String, prefix: &str, line: &str) {
    output.push_str(prefix);
    output.push_str(line);
    output.push('\n');
}

fn assert_print_myers(diff: &[AssertDiffLine<'_>]) -> (String, bool) {
    let mut output = String::new();
    let mut skipped = false;
    let mut common_count = 0;
    for index in (0..diff.len()).rev() {
        let operation = diff[index].operation;
        if index + 1 < diff.len() && diff[index + 1].operation == 0 && operation != 0 {
            match common_count {
                6 => assert_diff_line(&mut output, "  ", diff[index + 1].line),
                7 => {
                    assert_diff_line(&mut output, "  ", diff[index + 2].line);
                    assert_diff_line(&mut output, "  ", diff[index + 1].line);
                }
                8.. => {
                    output.push_str("...\n");
                    assert_diff_line(&mut output, "  ", diff[index + 1].line);
                    skipped = true;
                }
                _ => {}
            }
            common_count = 0;
        }
        match operation {
            1 => assert_diff_line(&mut output, "+ ", diff[index].line),
            -1 => assert_diff_line(&mut output, "- ", diff[index].line),
            _ => {
                if common_count < 5 {
                    assert_diff_line(&mut output, "  ", diff[index].line);
                }
                common_count += 1;
            }
        }
    }
    while output.ends_with('\n') || output.ends_with(' ') {
        output.pop();
    }
    (output, skipped)
}

#[allow(clippy::too_many_arguments)]
fn assert_dyn_equal_message(
    actual: &str,
    expected: &str,
    actual_object: bool,
    expected_object: bool,
    both_functions: bool,
    actual_string: bool,
    expected_string: bool,
    both_zero: bool,
    deep: bool,
    message: &JsString,
    has_message: bool,
) -> ! {
    let object_operator = !deep && ((actual_object && expected_object) || both_functions);
    let header = if deep {
        "Expected values to be strictly deep-equal:"
    } else if object_operator {
        "Expected \"actual\" to be reference-equal to \"expected\":"
    } else {
        "Expected values to be strictly equal:"
    };
    let actual_lines = actual.split('\n').collect::<Vec<_>>();
    let expected_lines = expected.split('\n').collect::<Vec<_>>();
    let simple = actual_lines.len() == 1
        && expected_lines.len() == 1
        && (!actual_object || !expected_object);
    let chosen_header = if has_message && !message.is_empty() {
        message.as_ref()
    } else {
        header
    };
    let mut output = chosen_header.to_owned();

    if simple {
        let quote_count = usize::from(actual_string) + usize::from(expected_string);
        let content_len = actual.len() + expected.len() - 2 * quote_count;
        if content_len <= 12 && !both_zero {
            output.push_str("\n\n");
            output.push_str(actual);
            output.push_str(" !== ");
            output.push_str(expected);
            output.push('\n');
        } else {
            output.push_str("\n+ actual - expected\n\n+ ");
            output.push_str(actual);
            output.push_str("\n- ");
            output.push_str(expected);
            if actual.len() + expected.len() <= 80 {
                let mismatch = actual
                    .bytes()
                    .zip(expected.bytes())
                    .position(|(left, right)| left != right);
                if let Some(index) = mismatch.filter(|index| *index >= 3) {
                    output.push('\n');
                    output.push_str(&" ".repeat(index + 2));
                    output.push('^');
                }
            }
            output.push('\n');
        }
    } else if actual == expected {
        if !(has_message && !message.is_empty()) {
            output = "Values have same structure but are not reference-equal:".to_owned();
        }
        output.push('\n');
        if actual_lines.len() > 50 {
            output.push_str("\n... Skipped lines\n");
            for line in actual_lines.iter().take(50) {
                output.push_str(line);
                output.push('\n');
            }
            output.push_str("...}\n");
        } else {
            output.push('\n');
            output.push_str(actual);
            output.push('\n');
        }
    } else {
        output.push_str("\n+ actual - expected");
        if let Some(diff) = assert_myers_diff(&actual_lines, &expected_lines, actual_object) {
            let (body, skipped) = assert_print_myers(&diff);
            if skipped {
                output.push_str("\n... Skipped lines");
            }
            output.push_str("\n\n");
            output.push_str(&body);
            output.push('\n');
        } else {
            output.push_str("\n\n");
            for line in actual_lines {
                assert_diff_line(&mut output, "+ ", line);
            }
            for (index, line) in expected_lines.iter().enumerate() {
                output.push_str("- ");
                output.push_str(line);
                if index + 1 < expected_lines.len() {
                    output.push('\n');
                }
            }
            output.push('\n');
        }
    }
    throw_assertion_error(output)
}

fn assert_dyn_not_equal_message(
    actual: &str,
    actual_reference: bool,
    deep: bool,
    message: &JsString,
    has_message: bool,
) -> ! {
    if has_message {
        throw_assertion_error(message.to_string());
    }
    let header = if deep {
        "Expected \"actual\" not to be strictly deep-equal to:"
    } else if actual_reference {
        "Expected \"actual\" not to be reference-equal to \"expected\":"
    } else {
        "Expected \"actual\" to be strictly unequal to:"
    };
    let lines = actual.split('\n').collect::<Vec<_>>();
    let mut output = header.to_owned();
    if lines.len() == 1 {
        output.push_str(if lines[0].len() > 5 { "\n\n" } else { " " });
        output.push_str(actual);
    } else {
        output.push_str("\n\n");
        let shown = if lines.len() > 50 { 47 } else { lines.len() };
        for (index, line) in lines.iter().take(shown).enumerate() {
            if lines.len() > 50 && index == 46 {
                output.push_str("...");
            } else {
                output.push_str(line);
            }
            output.push('\n');
        }
    }
    throw_assertion_error(output)
}

#[allow(clippy::too_many_arguments)]
pub fn assert_dyn_message(
    equal: bool,
    actual: &str,
    expected: &str,
    actual_object: bool,
    expected_object: bool,
    actual_function: bool,
    expected_function: bool,
    actual_string: bool,
    expected_string: bool,
    both_zero: bool,
    negated: bool,
    deep: bool,
    message: &JsString,
    has_message: bool,
) {
    if (negated && !equal) || (!negated && equal) {
        return;
    }
    if negated {
        assert_dyn_not_equal_message(
            actual,
            actual_object || actual_function,
            deep,
            message,
            has_message,
        );
    }
    assert_dyn_equal_message(
        actual,
        expected,
        actual_object,
        expected_object,
        actual_function && expected_function,
        actual_string,
        expected_string,
        both_zero,
        deep,
        message,
        has_message,
    )
}

pub fn assert_if_error_detail(detail: &str) -> ! {
    throw_assertion_error(format!("ifError got unwanted exception: {detail}"))
}

pub fn assert_unwanted_rejection(
    actual_message: &JsString,
    message: &JsString,
    has_message: bool,
) -> ! {
    let separator = if has_message {
        format!(": {message}")
    } else {
        ".".to_owned()
    };
    throw_assertion_error(format!(
        "Got unwanted rejection{separator}\nActual message: \"{actual_message}\""
    ))
}

pub fn assert_if_error_parts(name: &JsString, message: &JsString) -> ! {
    assert_if_error_detail(if message.is_empty() { name } else { message })
}

pub fn assert_if_error_f64(value: f64) -> ! {
    assert_if_error_detail(&display_number(value))
}

pub fn assert_if_error_string(value: &JsString) -> ! {
    assert_if_error_detail(&assert_inspect_string(value))
}

pub fn assert_if_error_bool(value: bool) -> ! {
    assert_if_error_detail(if value { "true" } else { "false" })
}
