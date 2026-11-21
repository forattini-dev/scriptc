import { initializeApp, getRuntimeScopeForApp } from './context.mjs';
export function render() {
  const appContext = initializeApp(process.stdin, process.stdout);
  const scope = getRuntimeScopeForApp(appContext);
  if (!scope) { appContext.dispose(); throw new Error('scope'); }
  appContext.setRawMode(true);
  console.log('raw', appContext.isRawModeEnabled(), appContext.rawModeEnabledCount);
  appContext.rawModeEnabledCount = 0;
  console.log('setter', appContext.isRawModeEnabled(), appContext.rawModeEnabledCount);
  appContext.setRawMode(true);
  appContext.dispose();
  console.log('disposed', appContext.isRawModeEnabled(), appContext.rawModeEnabledCount);
}
