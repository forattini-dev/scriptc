export const moduleUrl = import.meta.url;
export function filename(suffix: string): string { return import.meta.filename + suffix; }
export function directory(): string { return import.meta.dirname; }
export function captured(): () => string { return () => import.meta.url; }
