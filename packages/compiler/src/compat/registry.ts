/**
 * The registry of builtin-class compatibility profiles.
 *
 * Everything that consumes profiles generically — the surface-manifest
 * projection, the conformance harness's shared probes — iterates this list
 * rather than naming one profile, so adding a profile is one line here
 * plus its own data module and conformance suite.
 */

import { EVENTS_COMPAT_PROJECTION } from "./events-profile.js";
import { FETCH_COMPAT_PROJECTION } from "./fetch-profile.js";
import { URL_COMPAT_PROJECTION } from "./url-profile.js";
import type { CompatProfileProjection } from "./profile-schema.js";

export const COMPAT_PROFILES: readonly CompatProfileProjection[] = [
  FETCH_COMPAT_PROJECTION,
  URL_COMPAT_PROJECTION,
  EVENTS_COMPAT_PROJECTION,
];
