export interface AppContext {
  exit: (error?: Error) => void;
  dispose: () => void;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  onExit: (callback: (error?: Error) => void) => () => void;
  autoTabNavigation: boolean;
  setAutoTabNavigation: (enabled: boolean) => void;
  setRawMode: (enabled: boolean) => void;
  rawModeEnabledCount: number;
  isRawModeEnabled: () => boolean;
  isTerminalFocused?: () => boolean;
  clearScreen?: () => void;
  writeLine: (text: string) => void;
  enqueueExternalUpdate?: (update: () => void) => void;
  flushExternalUpdates?: () => void;
  hasPendingExternalUpdates?: () => boolean;
}
export function initializeApp(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): AppContext;
export function getRuntimeScopeForApp(context: AppContext): object | null;
