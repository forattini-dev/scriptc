/// UTC and local construction share MakeDay/MakeTime. Only the final UTC
/// instant is TimeClip'd: a local time outside the range can still be valid.
pub fn date_utc(y: f64, mo: f64, d: f64, h: f64, mi: f64, sec: f64, ms: f64) -> f64 {
    date_new_ms(date_components_ms(y, mo, d, h, mi, sec, ms))
}

pub fn date_new_components(y: f64, mo: f64, d: f64, h: f64, mi: f64, sec: f64, ms: f64) -> f64 {
    let local = date_components_ms(y, mo, d, h, mi, sec, ms);
    // IANA zone changes include a skipped day (Apia). Probe both sides of a
    // two-day window, retaining second-precision historical offsets.
    let window = 172_800_000.0;
    if !local.is_finite() || local.abs() > 8_640_000_000_000_000.0 + window {
        return f64::NAN;
    }
    let mut earliest = f64::INFINITY;
    let mut after_gap = f64::INFINITY;
    let mut gap = f64::INFINITY;
    for delta in [-window, 0.0, window] {
        let Some(offset) = date_local_offset_seconds(((local + delta) / 1_000.0).floor()) else { continue; };
        let candidate = local - offset * 1_000.0;
        let Some(actual) = date_local_offset_seconds((candidate / 1_000.0).floor()) else { continue; };
        let displacement = (actual - offset) * 1_000.0;
        if displacement == 0.0 {
            earliest = earliest.min(candidate);
        } else if displacement > 0.0 && displacement < gap {
            // Nonexistent civil time: use the pre-transition offset, moving
            // forward by the gap. Ambiguous time: earliest matching instant.
            gap = displacement;
            after_gap = candidate;
        }
    }
    date_new_ms(if earliest.is_finite() { earliest } else { after_gap })
}
