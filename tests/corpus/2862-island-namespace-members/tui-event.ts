// A STATIC module whose exports are island handles, read through its own
// namespace name.
export * as TuiEvent from "./tui-event.ts";
import { make } from "./inner.ts";
export const PromptAppend = make("tui.prompt.append");
export const ToastShow = make("tui.toast.show");
