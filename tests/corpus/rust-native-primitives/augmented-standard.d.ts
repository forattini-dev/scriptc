// Type-only additions must not change the identity of the standard values.
interface Array<T> { readonly nativeFixtureMarker?: T }
interface Math { readonly nativeFixtureMarker?: number }
interface String { readonly nativeFixtureMarker?: string }
