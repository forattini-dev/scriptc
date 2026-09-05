// @dynamic
// @island-module: ./inner.ts
// Qualified reads through a namespace whose members are island handles:
// `Ns.member` resolves to the member's handle (never the namespace
// object), for a static module of handles and for a barrel over an
// island module.
import * as Locale from "./locale.ts";
import { TuiEvent } from "./tui-event.ts";

console.log(Locale.truncate("hello world", 5));
console.log(TuiEvent.PromptAppend.type, TuiEvent.ToastShow.data.length);
console.log(Locale.Locale.truncate("abc", 5));
