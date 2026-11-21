let saved;
export function initializeApp(stdin, stdout) {
  let raw = false;
  let appContext;
  appContext = { exit() {}, dispose() { raw = false; }, stdin, stdout,
    onExit(callback) { return () => callback(); }, autoTabNavigation: true,
    setAutoTabNavigation(value) { this.autoTabNavigation = value; },
    setRawMode(value) { raw = value; }, get rawModeEnabledCount() { return raw ? 1 : 0; },
    set rawModeEnabledCount(value) { raw = value > 0; },
    isRawModeEnabled() { return raw; }, writeLine(text) { console.log(text); } };
  saved = appContext;
  return appContext;
}
export function getRuntimeScopeForApp(context) { return context === saved ? {} : null; }
