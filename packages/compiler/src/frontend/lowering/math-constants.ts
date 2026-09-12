/** Math properties with a STATIC lowering: each read becomes the exact
 * JavaScript numeric constant in the typed IR. No runtime Math object read or
 * dynamic-engine dependency is involved. Remaining Math properties retain
 * their island/fence behavior through ISLAND_SURFACE.math.props and the
 * generic standard-library member fence. */
export const STATIC_MATH_PROPS: Record<string, number | undefined> = {
  PI: 3.141592653589793,
  E: 2.718281828459045,
};
