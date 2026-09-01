/**
 * The Node runtime matrix every compatibility profile is censused against.
 *
 * scriptc targets two Node majors as first-class runtimes, so the version
 * axis of a compat profile is a LIST, not a pin. This module is the one
 * place the list lives: the profiles reference these ids and versions, the
 * conformance suites select one of them from the running runtime, and the
 * `gate:node-matrix` runner reads them to decide which interpreters to
 * spawn.
 *
 * The rule that keeps the matrix honest: a target is in this list only
 * because its reflection has actually been run. Every member the two
 * majors disagree on is written down as a version-qualified inventory row
 * (`targets: [...]`) in the profile that owns it, so the delta is data a
 * reader can inspect rather than a claim to be trusted. Adding a third
 * runtime means running the probes again and reconciling every profile —
 * nothing here may be filled in from a changelog.
 *
 * The primary is the runtime .node-version pins and the one whose label
 * stamps every shared manifest row; a candidate is equally supported, just
 * not the label the manifest prose is written against.
 */

import type { CompatTargets } from "./profile-schema.js";

/** The stable target ids inventory rows use as version qualifiers. */
export const NODE24_TARGET_ID = "node24";
export const NODE26_TARGET_ID = "node26";

/** The exact Node builds censused, matching .node-version (primary) and
 * the candidate the matrix gate runs alongside it. */
export const NODE24_VERSION = "24.15.0";
export const NODE26_VERSION = "26.8.1";

/** The bundled Undici build behind each major's fetch surface — the
 * fetch profile's second observable component. */
export const NODE24_UNDICI_VERSION = "7.24.4";
export const NODE26_UNDICI_VERSION = "8.10.0";

/** The matrix as a version axis, for profiles whose surface has no
 * observable component beyond the Node build itself. The fetch profile
 * builds its own from the same constants because its rows also depend on
 * the bundled Undici. */
export const NODE_COMPAT_MATRIX: CompatTargets = {
  primary: { id: NODE24_TARGET_ID, node: NODE24_VERSION },
  candidates: [{ id: NODE26_TARGET_ID, node: NODE26_VERSION }],
};
