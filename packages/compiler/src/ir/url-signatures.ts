import { BOOL, STRING, URL_T, VOID } from "./ir.js";

export type IrUrlLibFn =
  /** node:url + the URL class (scr_url.c). url.new parses one absolute
   * URL string into an immutable URL value (+1) — invalid input THROWS a
   * catchable TypeError ("Invalid URL"), like Node's constructor. The
   * getters (borrowed receiver, +1 string) never throw; url.href doubles
   * as toString(). fileURLToPath has one libFn per receiver form (URL
   * value / string) — both THROW Node's TypeErrors on non-file schemes,
   * encoded slashes, and non-empty hosts. url.pathToFileURL resolves the
   * path (getcwd) and never throws. */
  | "url.new"
  /** Resolve a string input against a string base. Both are evaluated
   * before parsing; invalid base or input throws TypeError. Rust native. */
  | "url.newBase"
  | "url.protocol"
  | "url.host"
  | "url.hostname"
  | "url.pathname"
  | "url.setPathname"
  | "url.href"
  /** The remaining WHATWG component getters, all pure reads of fields the
   * parser already normalized: url.port answers "" when the port is absent
   * or the scheme default; url.origin answers "scheme://host[:port]" for
   * the tuple-origin special schemes and the literal "null" for file: and
   * every opaque-path scheme; url.hash answers "" for BOTH no fragment and
   * a bare '#'; url.username / url.password split the stored userinfo at
   * its first ':' and answer "" when absent. */
  | "url.port"
  | "url.origin"
  | "url.hash"
  | "url.username"
  | "url.password"
  /** URL.canParse(input): url.new's accept/reject as a boolean. The one
   * URL entry point that NEVER throws — deliberately absent from the
   * may-throw seed set below. */
  | "url.canParse"
  /** The non-throwing decision for url.newBase. */
  | "url.canParseBase"
  | "url.fileURLToPathUrl"
  | "url.fileURLToPathStr"
  | "url.pathToFileURL"
  /** pathToFileURL under a win32 TARGET: the same scr_url_from_path call
   * (the runtime selects the win32 arm by _WIN32), but a distinct IR name
   * because that arm THROWS for malformed UNC inputs — may-throw seeds on
   * it while posix pathToFileURL emission stays byte-identical. */
  | "url.pathToFileURLWin32";

export const URL_LIB_FN_SIGS = {
  "url.new": { argTypes: [STRING], result: URL_T },
  "url.newBase": { argTypes: [STRING, STRING], result: URL_T },
  "url.protocol": { argTypes: [URL_T], result: STRING },
  "url.host": { argTypes: [URL_T], result: STRING },
  "url.hostname": { argTypes: [URL_T], result: STRING },
  "url.pathname": { argTypes: [URL_T], result: STRING },
  "url.setPathname": { argTypes: [URL_T, STRING], result: VOID },
  "url.href": { argTypes: [URL_T], result: STRING },
  "url.port": { argTypes: [URL_T], result: STRING },
  "url.origin": { argTypes: [URL_T], result: STRING },
  "url.hash": { argTypes: [URL_T], result: STRING },
  "url.username": { argTypes: [URL_T], result: STRING },
  "url.password": { argTypes: [URL_T], result: STRING },
  "url.canParse": { argTypes: [STRING], result: BOOL },
  "url.canParseBase": { argTypes: [STRING, STRING], result: BOOL },
  "url.fileURLToPathUrl": { argTypes: [URL_T], result: STRING },
  "url.fileURLToPathStr": { argTypes: [STRING], result: STRING },
  "url.pathToFileURL": { argTypes: [STRING], result: URL_T },
  "url.pathToFileURLWin32": { argTypes: [STRING], result: URL_T },
};
