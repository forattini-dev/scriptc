import { NUMERIC_COERCION_RUNTIME_NAMES } from "./numeric-coercion.js";
/* Shared tables and emission shapes for LLVM standard-library dispatch. */
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { f64Lit } from "./common.js";

/** Emit a validation-ladder call that always throws, preserving the typed
 * dummy-result ownership shape until the pending check unwinds it. */
export function emitAlwaysThrowLibCall(
  host: LlvmEmitterContext,
  e: LibCallExpr,
  sym: string,
): LlValue {
  const args = e.args.map((a) => host.emitExpr(a));
  host.declare(`declare void @${sym}(${args.map(() => "ptr").join(", ")})`);
  host.B.line(`call void @${sym}(${args.map((a) => `ptr ${a.name}`).join(", ")})`);
  const ty = host.llType(e.type);
  if (ty === "void") {
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
  const out = host.own({ name: dummy, type: e.type });
  host.emitPendingCheck();
  return out;
}

export const LIB_FN_SYMS: Record<string, string> = {
  ...NUMERIC_COERCION_RUNTIME_NAMES,
  "util.parseArgs": "scr_util_parse_args",
  "math.maxArr": "scr_math_max_arr",
  "math.minArr": "scr_math_min_arr",
  "math.hypotArr": "scr_math_hypot_arr",
  "math.min": "scr_math_min",
  "math.max": "scr_math_max",
  "math.random": "scr_math_random",
  "math.round": "scr_math_round",
  "http.clientFlushHeaders": "scr_http_client_flush_headers",
  "http.clientAddTrailers": "scr_http_client_add_trailers",
  "http.clientCork": "scr_http_client_cork",
  "http.clientUncork": "scr_http_client_uncork",
  "http.clientWritableCorked": "scr_http_client_writable_corked",
  "http.clientMethod": "scr_http_client_method",
  "http.clientPath": "scr_http_client_path",
  "http.clientHost": "scr_http_client_host",
  "http.clientProtocol": "scr_http_client_protocol",
  "http.clientHeadersSent": "scr_http_client_headers_sent",
  "http.clientWritableEnded": "scr_http_client_writable_ended",
  "http.clientWritableFinished": "scr_http_client_writable_finished",
  "http.clientSocket": "scr_http_client_socket",
  "http.clientReusedSocket": "scr_http_client_reused_socket",
  "http.clientSetNoDelay": "scr_http_client_set_nodelay",
  "http.clientSetSocketKeepAlive": "scr_http_client_set_socket_keepalive",
  "http.clientSetTimeout": "scr_http_client_set_timeout",
  "http.statusCodes": "scr_http_status_codes",
  "http.methods": "scr_http_methods",
  "http.reqSetTimeout": "scr_http_req_set_timeout_plain",
