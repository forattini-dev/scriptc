/** Rust str literals cannot encode lone UTF-16 surrogates. Emit their units
 * directly; ordinary literals keep the existing compact UTF-8 constructor. */
export function rustJsString(value: string, escape: (value: string) => string): string {
  if (/[\uD800-\uDFFF]/u.test(value)) {
    const units: number[] = [];
    for (let index = 0; index < value.length; index++) units.push(value.charCodeAt(index));
    return `runtime::string_from_utf16(&[${units.map(unit => `0x${unit.toString(16)}`).join(", ")}])`;
  }
  return `runtime::string("${escape(value)}")`;
}

/** Borrow static UTF-8 names without allocating; preserve exceptional units. */
export function rustJsStringRef(value: string, escape: (value: string) => string): string {
  return /[\uD800-\uDFFF]/u.test(value)
    ? `&${rustJsString(value, escape)}` : `"${escape(value)}"`;
}
