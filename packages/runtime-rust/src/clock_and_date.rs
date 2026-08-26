trait DynNode {
    fn id(&self) -> usize;
    fn trace(&self, tracer: &mut Tracer<'_>);
    fn clear_edges(&self);
}

type DynNodeRc = Rc<dyn DynNode>;
type DynNodeWeak = Weak<dyn DynNode>;

thread_local! {
    static NEXT_NODE_ID: Cell<usize> = const { Cell::new(1) };
    static LIVE_NODES: Cell<usize> = const { Cell::new(0) };
    static CYCLE_CANDIDATES: RefCell<Vec<DynNodeWeak>> = const { RefCell::new(Vec::new()) };
    static EXCEPTION_SLOT: RefCell<Option<Rc<dyn Any>>> = const { RefCell::new(None) };
    static PROCESS_ARGV: RefCell<Option<JsArray<JsString>>> = const { RefCell::new(None) };
    static OPEN_FILES: RefCell<HashMap<i32, std::fs::File>> = RefCell::new(HashMap::new());
    #[cfg(not(unix))]
    static NEXT_FILE_ID: Cell<i32> = const { Cell::new(3) };
    static TIMER_TASKS: RefCell<Vec<TimerTask>> = const { RefCell::new(Vec::new()) };
    static NEXT_TIMER_ID: Cell<u64> = const { Cell::new(1) };
    static IMMEDIATE_TASKS: RefCell<Vec<ImmediateTask>> = const { RefCell::new(Vec::new()) };
    static NEXT_IMMEDIATE_ID: Cell<u64> = const { Cell::new(1) };
    static MICROTASKS: RefCell<VecDeque<Box<dyn FnOnce()>>> = const { RefCell::new(VecDeque::new()) };
    static NEXT_TICKS: RefCell<VecDeque<Box<dyn FnOnce()>>> = const { RefCell::new(VecDeque::new()) };
    static PROMISE_CHECKS: RefCell<VecDeque<Box<dyn FnOnce()>>> = const { RefCell::new(VecDeque::new()) };
    static UNHANDLED_REJECTION: Cell<bool> = const { Cell::new(false) };
    static UNHANDLED_REJECTION_HANDLER: RefCell<Option<Box<dyn FnMut(Caught, JsPromiseHandle)>>> = const { RefCell::new(None) };
    static REJECTION_HANDLED_HANDLER: RefCell<Option<Box<dyn FnMut(JsPromiseHandle)>>> = const { RefCell::new(None) };
    static EVENT_TURN: Cell<u64> = const { Cell::new(0) };
    static EVENT_PHASE: Cell<u8> = const { Cell::new(0) };
    static FIRING_TIMER_ID: Cell<u64> = const { Cell::new(0) };
    static FIRING_TIMER_REFRESHED: Cell<bool> = const { Cell::new(false) };
    static FIRING_TIMER_CLEARED: Cell<bool> = const { Cell::new(false) };
    static FIRING_TIMER_REFERENCED: Cell<bool> = const { Cell::new(true) };
    static FS_RENAME_CALLBACKS: RefCell<HashMap<u64, FsRenameCallback>> = RefCell::new(HashMap::new());
}

/// Visitor used by generated heap payloads to expose owning edges.
///
/// The visitor stores only `Weak` references, so a collection pass never
/// changes the liveness result it is trying to compute.
pub struct Tracer<'a> {
    visit: &'a mut dyn FnMut(DynNodeWeak),
}

pub fn init() {
    let _ = PROCESS_START.get_or_init(std::time::Instant::now);
    PROMISE_CHECKS.with(|checks| checks.borrow_mut().clear());
    UNHANDLED_REJECTION.with(|unhandled| unhandled.set(false));
    UNHANDLED_REJECTION_HANDLER.with(|handler| *handler.borrow_mut() = None);
    REJECTION_HANDLED_HANDLER.with(|handler| *handler.borrow_mut() = None);
}

fn process_elapsed() -> std::time::Duration {
    PROCESS_START.get_or_init(std::time::Instant::now).elapsed()
}

pub fn process_uptime() -> f64 {
    process_elapsed().as_secs_f64()
}

pub fn performance_now() -> f64 {
    process_elapsed().as_secs_f64() * 1000.0
}

pub fn date_now() -> f64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as f64,
        Err(error) => {
            let duration = error.duration();
            let millis = duration.as_millis() as f64;
            if duration.subsec_nanos() % 1_000_000 == 0 {
                -millis
            } else {
                -(millis + 1.0)
            }
        }
    }
}

/// ECMAScript TimeClip for the read-only Date value representation.
pub fn date_new_ms(ms: f64) -> f64 {
    if !ms.is_finite() || ms.abs() > 8_640_000_000_000_000.0 {
        return f64::NAN;
    }
    let clipped = ms.trunc();
    if clipped == 0.0 { 0.0 } else { clipped }
}

pub fn date_get_time(ms: f64) -> f64 {
    ms
}

fn civil_from_days(day: i64) -> (i64, u64, u64) {
    let z = day + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let date = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    if month <= 2 {
        year += 1;
    }
    (year, month, date)
}

/// Date.prototype.toISOString over a TimeClip'd millisecond scalar.
pub fn date_to_iso(ms: f64) -> JsString {
    if !ms.is_finite() || ms.abs() > 8_640_000_000_000_000.0 {
        throw_range_error("Invalid time value".to_owned());
    }
    let time = ms.trunc();
    let day = (time / 86_400_000.0).floor();
    let millis_of_day = (time - day * 86_400_000.0) as i64;
    let (year, month, date) = civil_from_days(day as i64);
    let hours = millis_of_day / 3_600_000;
    let minutes = millis_of_day / 60_000 % 60;
    let seconds = millis_of_day / 1_000 % 60;
    let millis = millis_of_day % 1_000;
    let year_text = if year < 0 {
        format!("-{:06}", -year)
    } else if year > 9_999 {
        format!("+{:06}", year)
    } else {
        format!("{:04}", year)
    };
    string(&format!(
        "{year_text}-{month:02}-{date:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z"
    ))
}

fn days_from_civil(mut year: i64, month: i32, date: i32) -> f64 {
    year -= i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u64;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = ((153 * month_prime + 2) / 5 + date - 1) as u64;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    (era * 146_097 + day_of_era as i64 - 719_468) as f64
}

/// Date.UTC's MakeDay/MakeTime/TimeClip pipeline over numeric arguments.
pub fn date_utc(
    year: f64,
    month: f64,
    date: f64,
    hours: f64,
    minutes: f64,
    seconds: f64,
    ms: f64,
) -> f64 {
    if !year.is_finite()
        || !month.is_finite()
        || !date.is_finite()
        || !hours.is_finite()
        || !minutes.is_finite()
        || !seconds.is_finite()
        || !ms.is_finite()
    {
        return f64::NAN;
    }
    let mut year = year.trunc();
    let month = month.trunc();
    let date = date.trunc();
    let hours = hours.trunc();
    let minutes = minutes.trunc();
    let seconds = seconds.trunc();
    let ms = ms.trunc();
    if year.abs() > 1_000_000.0 || month.abs() > 10_000_000.0 {
        return f64::NAN;
    }
    if (0.0..=99.0).contains(&year) {
        year += 1_900.0;
    }
    let month_cycles = (month / 12.0).floor();
    let normalized_year = year + month_cycles;
    let normalized_month = (month - month_cycles * 12.0) as i32;
    let days = days_from_civil(normalized_year as i64, normalized_month + 1, 1) + (date - 1.0);
    let time =
        days * 86_400_000.0 + hours * 3_600_000.0 + minutes * 60_000.0 + seconds * 1_000.0 + ms;
    if time.abs() > 8_640_000_000_000_000.0 {
        return f64::NAN;
    }
    if time == 0.0 { 0.0 } else { time }
}

fn date_make_ms(
    year: i64,
    month: i32,
    date: i32,
    hours: i32,
    minutes: i32,
    seconds: i32,
    ms: i32,
) -> f64 {
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&date)
        || hours > 24
        || minutes > 59
        || seconds > 59
        || (hours == 24 && (minutes != 0 || seconds != 0 || ms != 0))
    {
        return f64::NAN;
    }
    days_from_civil(year, month, date) * 86_400_000.0
        + f64::from(hours) * 3_600_000.0
        + f64::from(minutes) * 60_000.0
        + f64::from(seconds) * 1_000.0
        + f64::from(ms)
}

fn date_take_digits(bytes: &[u8], cursor: &mut usize, count: usize) -> Option<i32> {
    if bytes.len().saturating_sub(*cursor) < count {
        return None;
    }
    let mut value = 0_i32;
    for byte in &bytes[*cursor..*cursor + count] {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i32::from(*byte - b'0');
    }
    *cursor += count;
    Some(value)
}

/// The bounded parser shared with the C runtime: ASN.1 certificate dates
/// and ECMAScript's own date-time format with an explicit timezone.
pub fn date_parse_get_time(value: &JsString) -> f64 {
    let bytes = value.as_bytes();

    if bytes.len() > 3 && bytes[0].is_ascii_alphabetic() {
        const MONTHS: [&[u8; 3]; 12] = [
            b"Jan", b"Feb", b"Mar", b"Apr", b"May", b"Jun", b"Jul", b"Aug", b"Sep", b"Oct", b"Nov",
            b"Dec",
        ];
        let Some(month) = MONTHS
            .iter()
            .position(|candidate| bytes[..3].eq_ignore_ascii_case(candidate.as_slice()))
            .map(|index| index as i32 + 1)
        else {
            return f64::NAN;
        };
        let mut cursor = 3;
        if bytes.get(cursor) == Some(&b' ') {
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&b' ') {
            cursor += 1;
        }
        let Some(mut date) = date_take_digits(bytes, &mut cursor, 1) else {
            return f64::NAN;
        };
        if bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            let Some(second) = date_take_digits(bytes, &mut cursor, 1) else {
                return f64::NAN;
            };
            date = date * 10 + second;
        }
        if bytes.get(cursor) != Some(&b' ') {
            return f64::NAN;
        }
        cursor += 1;
        let Some(hours) = date_take_digits(bytes, &mut cursor, 2) else {
            return f64::NAN;
        };
        if bytes.get(cursor) != Some(&b':') {
            return f64::NAN;
        }
        cursor += 1;
        let Some(minutes) = date_take_digits(bytes, &mut cursor, 2) else {
            return f64::NAN;
        };
        if bytes.get(cursor) != Some(&b':') {
            return f64::NAN;
        }
        cursor += 1;
        let Some(seconds) = date_take_digits(bytes, &mut cursor, 2) else {
            return f64::NAN;
        };
        if bytes.get(cursor) != Some(&b' ') {
            return f64::NAN;
        }
        cursor += 1;
        let Some(year) = date_take_digits(bytes, &mut cursor, 4) else {
            return f64::NAN;
        };
        if bytes.get(cursor..) != Some(b" GMT") {
            return f64::NAN;
        }
        return date_new_ms(date_make_ms(
            i64::from(year),
            month,
            date,
            hours,
            minutes,
            seconds,
            0,
        ));
    }

    let mut cursor = 0;
    let signed_year = matches!(bytes.get(cursor), Some(b'+') | Some(b'-'));
    let year = if signed_year {
        let negative = bytes[cursor] == b'-';
        cursor += 1;
        let Some(year) = date_take_digits(bytes, &mut cursor, 6) else {
            return f64::NAN;
        };
        if negative && year == 0 {
            return f64::NAN;
        }
        if negative {
            -i64::from(year)
        } else {
            i64::from(year)
        }
    } else {
        let Some(year) = date_take_digits(bytes, &mut cursor, 4) else {
            return f64::NAN;
        };
        i64::from(year)
    };
    let mut month = 1;
    let mut date = 1;
    if bytes.get(cursor) == Some(&b'-') {
        cursor += 1;
        let Some(parsed) = date_take_digits(bytes, &mut cursor, 2) else {
            return f64::NAN;
        };
        month = parsed;
        if bytes.get(cursor) == Some(&b'-') {
            cursor += 1;
            let Some(parsed) = date_take_digits(bytes, &mut cursor, 2) else {
                return f64::NAN;
            };
            date = parsed;
        }
    }
    if cursor == bytes.len() {
        return date_new_ms(date_make_ms(year, month, date, 0, 0, 0, 0));
    }
    if bytes.get(cursor) != Some(&b'T') {
        return f64::NAN;
    }
    cursor += 1;
    let Some(hours) = date_take_digits(bytes, &mut cursor, 2) else {
        return f64::NAN;
    };
    if bytes.get(cursor) != Some(&b':') {
        return f64::NAN;
    }
    cursor += 1;
    let Some(minutes) = date_take_digits(bytes, &mut cursor, 2) else {
        return f64::NAN;
    };
    let mut seconds = 0;
    let mut ms = 0;
    if bytes.get(cursor) == Some(&b':') {
        cursor += 1;
        let Some(parsed) = date_take_digits(bytes, &mut cursor, 2) else {
            return f64::NAN;
        };
        seconds = parsed;
        if bytes.get(cursor) == Some(&b'.') {
            cursor += 1;
            let Some(parsed) = date_take_digits(bytes, &mut cursor, 3) else {
                return f64::NAN;
            };
            ms = parsed;
        }
    }
    if cursor == bytes.len() {
        return f64::NAN;
    }
    let offset = match bytes[cursor] {
        b'Z' => {
            cursor += 1;
            0.0
        }
        b'+' | b'-' => {
            let negative = bytes[cursor] == b'-';
            cursor += 1;
            let Some(offset_hours) = date_take_digits(bytes, &mut cursor, 2) else {
                return f64::NAN;
            };
            if bytes.get(cursor) != Some(&b':') {
                return f64::NAN;
            }
            cursor += 1;
            let Some(offset_minutes) = date_take_digits(bytes, &mut cursor, 2) else {
                return f64::NAN;
            };
            if offset_hours > 23 || offset_minutes > 59 {
                return f64::NAN;
            }
            let value = f64::from(offset_hours * 60 + offset_minutes) * 60_000.0;
            if negative { -value } else { value }
        }
        _ => return f64::NAN,
    };
    if cursor != bytes.len() {
        return f64::NAN;
    }
    date_new_ms(date_make_ms(year, month, date, hours, minutes, seconds, ms) - offset)
}

#[derive(Clone, Copy)]
struct DateParts {
    year: i64,
    month: i32,
    date: i32,
    day: i32,
    hours: i32,
    minutes: i32,
    seconds: i32,
    milliseconds: i32,
    timezone_offset: f64,
}

fn date_utc_parts_unchecked(time: f64) -> DateParts {
    let day = (time / 86_400_000.0).floor();
    let millis_of_day = (time - day * 86_400_000.0) as i64;
    let (year, month, date) = civil_from_days(day as i64);
    DateParts {
        year,
        month: month as i32 - 1,
        date: date as i32,
        day: ((day as i64 + 4).rem_euclid(7)) as i32,
        hours: (millis_of_day / 3_600_000) as i32,
        minutes: (millis_of_day / 60_000 % 60) as i32,
        seconds: (millis_of_day / 1_000 % 60) as i32,
        milliseconds: (millis_of_day % 1_000) as i32,
        timezone_offset: 0.0,
    }
}

fn date_utc_parts(ms: f64) -> Option<DateParts> {
    if !ms.is_finite() || ms.abs() > 8_640_000_000_000_000.0 {
        None
    } else {
        Some(date_utc_parts_unchecked(ms.trunc()))
    }
}

fn date_local_snapshot(seconds: f64) -> Option<(i64, i32, i32, i32, i32, i32)> {
    let seconds_integer = seconds as i64;
    if seconds_integer as f64 != seconds {
        return None;
    }
    let value = Local.timestamp_opt(seconds_integer, 0).single()?;
    Some((
        i64::from(value.year()),
        value.month() as i32,
        value.day() as i32,
        value.hour() as i32,
        value.minute() as i32,
        value.second() as i32,
    ))
}

fn date_local_parts(ms: f64) -> Option<DateParts> {
    if !ms.is_finite() || ms.abs() > 8_640_000_000_000_000.0 {
        return None;
    }
    let clipped = ms.trunc();
    let seconds = (clipped / 1_000.0).floor();
    let mut basis_seconds = seconds;
    let mut local = date_local_snapshot(basis_seconds);
    if local.is_none() {
        let utc = date_utc_parts_unchecked(clipped);
        let surrogate_year = 2_000 + (utc.year - 2_000).rem_euclid(400);
        basis_seconds = days_from_civil(surrogate_year, utc.month + 1, utc.date) * 86_400.0
            + f64::from(utc.hours) * 3_600.0
            + f64::from(utc.minutes) * 60.0
            + f64::from(utc.seconds);
        local = date_local_snapshot(basis_seconds);
    }
    let (year, month, date, hours, minutes, seconds) = local?;
    let local_as_utc = days_from_civil(year, month, date) * 86_400.0
        + f64::from(hours) * 3_600.0
        + f64::from(minutes) * 60.0
        + f64::from(seconds);
    let local_offset = local_as_utc - basis_seconds;
    let mut parts = date_utc_parts_unchecked(clipped + local_offset * 1_000.0);
    let timezone_offset = (-local_offset / 60.0).trunc();
    parts.timezone_offset = if timezone_offset == 0.0 {
        0.0
    } else {
        timezone_offset
    };
    Some(parts)
}

fn date_parts(ms: f64, utc: bool) -> Option<DateParts> {
    if utc {
        date_utc_parts(ms)
    } else {
        date_local_parts(ms)
    }
}

macro_rules! date_part_getter {
    ($name:ident, $field:ident) => {
        pub fn $name(ms: f64, utc: bool) -> f64 {
            date_parts(ms, utc).map_or(f64::NAN, |parts| parts.$field as f64)
        }
    };
}

date_part_getter!(date_get_full_year, year);
date_part_getter!(date_get_month, month);
date_part_getter!(date_get_date, date);
date_part_getter!(date_get_day, day);
date_part_getter!(date_get_hours, hours);
date_part_getter!(date_get_minutes, minutes);
date_part_getter!(date_get_seconds, seconds);

pub fn date_get_milliseconds(ms: f64) -> f64 {
    date_utc_parts(ms).map_or(f64::NAN, |parts| f64::from(parts.milliseconds))
}

pub fn date_get_timezone_offset(ms: f64) -> f64 {
    date_local_parts(ms).map_or(f64::NAN, |parts| parts.timezone_offset)
}
