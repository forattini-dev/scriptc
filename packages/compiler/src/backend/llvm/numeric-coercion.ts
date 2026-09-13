/** Borrowed arguments, LLVM types derived from validated IR signatures.
 * Dynamic conversions use the ordinary pending-exception protocol. */
export const NUMERIC_COERCION_RUNTIME_NAMES = {
  "num.parseInt": "scr_parse_int",
  "num.parseFloat": "scr_parse_float",
  "num.fromString": "scr_string_to_number",
  "dyn.toStringCoerce": "scr_dyn_string_coerce_js",
  "dyn.stringConstructor": "scr_dyn_string_coerce_js",
  "dyn.toNumberCoerce": "scr_dyn_number_coerce_value",
  "dyn.compare": "scr_dyn_compare",
};
