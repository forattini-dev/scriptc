import type { LibCallState } from "./lib-call-context.js";
import { InternalCompilerError } from "../../errors.js";
import type { Temp } from "./c-emitter.js";
import { BOOL, BYTES_U8, F64, isRefCounted, STRING } from "../../ir/ir.js";
import { cType } from "./types.js";
import { mangleField, mangleRecordNew } from "../mangle.js";
import { undefinedArmTag } from "../../ir/analysis.js";

export function emitNetworkLibCall(state: LibCallState): Temp {
  const { e, emitter, args, arg, finish } = state;
  const fn = e.fn;
  switch (fn) {
          // node:net (scr_net.c + the loop's net hook — linked only when
          // these appear on the IR). Receivers and data are borrowed;
          // CALLBACKS MOVE into the handle's registry (released at
          // settlement). listen/connect make the loop live: usesTimers.
          case "net.createServer":
            return finish(`scr_net_create_server(NULL, NULL)`);
          case "net.createServerCb": {
            const cbT = e.args[0]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: net.createServerCb handler not a func");
            const cb = args[0]!;
            emitter.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_net_conn_thunk0" : "scr_net_conn_thunk_sock";
            return finish(`scr_net_create_server(${cb.name}, &${adapter})`);
          }
          case "net.listen":
            emitter.usesTimers = true; // a listening server holds the loop open
            emitter.line(`scr_net_listen(${arg(0)}, ${arg(1)}, NULL);${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.listenCb": {
            emitter.usesTimers = true;
            const cb = args[2]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_net_listen(${arg(0)}, ${arg(1)}, ${cb.name});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.listenOpts":
            emitter.usesTimers = true;
            emitter.line(`scr_net_listen_opts(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, NULL);${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.listenOptsReusePort":
            emitter.usesTimers = true;
            emitter.line(`scr_net_listen_opts_reuse_port(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, NULL);${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.listenOptsCb": {
            emitter.usesTimers = true;
            // The callback slot may be the `(() => void) | undefined`
            // optional-binding union: unwrap to a nullable closure (the
            // createSecureServerSni pattern).
            const cbT = e.args[4]!.type;
            let cbExpr: string;
            if (cbT.kind === "func") {
              const cb = args[4]!;
              emitter.moveTemp(cb);
              cbExpr = cb.name;
            } else {
              if (cbT.kind !== "union") throw new InternalCompilerError("emitter bug: net.listenOptsCb callback shape");
              const def = emitter.unionsById.get(cbT.unionId);
              const funcTag = def ? def.arms.findIndex((a) => a.kind === "func") : -1;
              if (funcTag < 0) throw new InternalCompilerError("emitter bug: net.listenOptsCb union lacks its func arm");
              const u = args[4]!;
              const t = emitter.newTemp(
                def!.arms[funcTag]!,
                `${u.name}->tag == ${funcTag} ? scr_closure_retain((ScrClosure *)scr_union_peek(${u.name})) : NULL`,
              );
              emitter.moveTemp(t);
              cbExpr = t.name;
            }
            emitter.line(`scr_net_listen_opts(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${cbExpr});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.listenOptsReusePortCb": {
            emitter.usesTimers = true;
            // The callback slot follows reusePort in the additive ABI and
            // may be the `(() => void) | undefined` optional-binding union.
            const cbT = e.args[5]!.type;
            let cbExpr: string;
            if (cbT.kind === "func") {
              const cb = args[5]!;
              emitter.moveTemp(cb);
              cbExpr = cb.name;
            } else {
              if (cbT.kind !== "union") throw new InternalCompilerError("emitter bug: net.listenOptsReusePortCb callback shape");
              const def = emitter.unionsById.get(cbT.unionId);
              const funcTag = def ? def.arms.findIndex((a) => a.kind === "func") : -1;
              if (funcTag < 0) throw new InternalCompilerError("emitter bug: net.listenOptsReusePortCb union lacks its func arm");
              const u = args[5]!;
              const t = emitter.newTemp(
                def!.arms[funcTag]!,
                `${u.name}->tag == ${funcTag} ? scr_closure_retain((ScrClosure *)scr_union_peek(${u.name})) : NULL`,
              );
              emitter.moveTemp(t);
              cbExpr = t.name;
            }
            emitter.line(`scr_net_listen_opts_reuse_port(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${cbExpr});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverPort":
            return finish(`scr_net_server_port(${arg(0)})`);
          case "net.serverAddress": {
            // The AddressInfo record from the three runtime reads (the
            // dgram.address materialization; none of these throw).
            if (e.type.kind !== "record") throw new InternalCompilerError("emitter bug: net.serverAddress result is not a record");
            const ip = emitter.newTemp(STRING, `scr_net_server_addr_ip(${arg(0)})`);
            const rec = emitter.newTemp(e.type, `${mangleRecordNew(e.type.shapeId)}()`);
            emitter.moveTemp(ip);
            emitter.line(`${rec.name}->${mangleField("address")} = ${ip.name};`);
            emitter.line(`${rec.name}->${mangleField("family")} = scr_net_server_addr_family(${arg(0)});`);
            emitter.line(`${rec.name}->${mangleField("port")} = scr_net_server_port(${arg(0)});`);
            return rec;
          }
          case "net.serverClose":
            emitter.line(`scr_net_server_close(${arg(0)}, NULL);${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.serverCloseCb": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_net_server_close(${arg(0)}, ${cb.name});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverCloseBind": {
            // The bound REAL close as a value: an emitted adapter behind
            // a fresh closure whose one env slot holds the +1 server.
            if (e.type.kind !== "func") throw new InternalCompilerError("emitter bug: net.serverCloseBind result not a func");
            const fnSym = emitter.closeBindThunkFor(e.type.params[0]!, e.type.ret.kind === "netServer");
            const bound = emitter.newTemp(e.type, `scr_closure_new((void *)&${fnSym}, 1)`);
            emitter.line(`${bound.name}->caps[0] = scr_box_new_obj(&scr_net_server_retain_v, &scr_net_server_release_v, NULL);`);
            emitter.line(`scr_box_set_ref(${bound.name}->caps[0], scr_net_server_retain(${arg(0)}));`);
            return bound;
          }
          case "net.serverSetCloseOverride": {
            // The override MOVES into the server's slot behind the
            // emitted zero-arg wrapper (the runtime can't build the
            // callback union — tags are program data).
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: close override not a func");
            const wrapSym = emitter.closeOverrideWrapFor(cbT.params[0]!, cbT.ret.kind === "netServer");
            const cb = args[1]!;
            emitter.moveTemp(cb); // ownership moves into the wrapper's env box
            const wrap = emitter.newTemp(e.args[1]!.type, `scr_closure_new((void *)&${wrapSym}, 1)`);
            emitter.line(`${wrap.name}->caps[0] = scr_box_new(SCR_BOX_FUNC);`);
            emitter.line(`scr_box_set_ref(${wrap.name}->caps[0], ${cb.name});`);
            emitter.moveTemp(wrap); // and the wrapper moves into the server's slot
            emitter.line(`scr_net_server_set_close_override(${arg(0)}, ${wrap.name});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverOnError":
          case "net.sockOnError": {
            // The child %Error adapters fit exactly (message → %Error).
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError(`emitter bug: ${e.fn} callback not a func`);
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            const fn = e.fn === "net.serverOnError" ? "scr_net_server_on_error" : "scr_net_sock_on_error";
            emitter.line(`${fn}(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverOnClose": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_net_server_on_close(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.serverOnConnection":
          case "net.serverOnSecureConnection": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError(`emitter bug: ${e.fn} callback not a func`);
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_net_conn_thunk0" : "scr_net_conn_thunk_sock";
            const entry = e.fn === "net.serverOnConnection"
              ? "scr_net_server_on_connection"
              : "scr_net_server_on_secure_connection";
            emitter.line(`${entry}(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.connect":
            emitter.usesTimers = true; // a connecting/open socket holds the loop open
            return finish(`scr_net_connect(${arg(0)}, ${arg(1)}, NULL)`);
          case "net.connectAttempt":
            // The validated autoSelectFamilyAttemptTimeout form: Node's
            // range ladder runs first, the dial follows.
            emitter.usesTimers = true;
            return finish(`scr_net_connect_attempt(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "net.connectOptsChk":
            // The runtime option-bag ladder (always throws — a validation
            // error or the trailing fence; the error.nodeThrow dummy).
            return finish(
              `(scr_net_connect_opts_chk(${arg(0)}, ${arg(1)}), ${isRefCounted(e.type) ? `(${cType(e.type).trim()})NULL` : "0"})`,
            );
          case "net.connectCb": {
            emitter.usesTimers = true;
            const cb = args[2]!;
            emitter.moveTemp(cb);
            return finish(`scr_net_connect(${arg(0)}, ${arg(1)}, ${cb.name})`);
          }
          case "net.connectLookup": {
            // The caller-resolver dial: the runtime invokes the lookup
            // closure with (hostname, dyn undefined, answer-closure); the
            // answer closure's fn is the emitted per-shape thunk (its
            // union tag and record field are program data — the SNI
            // pattern). The lookup moves in.
            emitter.usesTimers = true;
            const lookupT = e.args[2]!.type;
            if (lookupT.kind !== "func" || lookupT.params[2]?.kind !== "func") {
              throw new InternalCompilerError("emitter bug: net.connectLookup resolver shape (frontend must fence)");
            }
            const thunk = emitter.netLookupAnswerThunkFor(lookupT.params[2]);
            const lookup = args[2]!;
            emitter.moveTemp(lookup);
            return finish(`scr_net_connect_lookup(${arg(0)}, ${arg(1)}, ${lookup.name}, (void *)&${thunk})`);
          }
          case "net.sockWrite":
            emitter.line(`scr_net_sock_write_str(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockWriteBytes":
            emitter.line(`scr_net_sock_write_bytes(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockEnd":
            emitter.line(`scr_net_sock_end(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockEndStr":
            emitter.line(`scr_net_sock_end_str(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockEndBytes":
            emitter.line(`scr_net_sock_end_bytes(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockWriteDyn":
            emitter.line(`scr_net_sock_write_dynv(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockEndDyn":
            emitter.line(`scr_net_sock_end_dynv(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockDestroy":
            emitter.line(`scr_net_sock_destroy(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockPause":
            return finish(`scr_net_sock_pause(${arg(0)})`);
          case "net.sockResume":
            return finish(`scr_net_sock_resume(${arg(0)})`);
          case "net.sockSetNoDelay":
            return finish(`scr_net_sock_set_nodelay(${arg(0)}, ${arg(1)})`);
          case "net.sockDestroySoon":
            emitter.line(`scr_net_sock_destroy_soon(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockBytesWritten":
            return finish(`scr_net_sock_bytes_written(${arg(0)})`);
          case "net.sockReadable":
            return finish(`scr_net_sock_readable(${arg(0)})`);
          case "net.sockOnFinish": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_net_sock_on_finish(${arg(0)}, ${cb.name});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockPipe":
            emitter.line(`scr_net_sock_pipe(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockOnData": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: net.sockOnData callback not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_net_data_thunk0"
              : cbT.params[0]!.kind === "dyn" ? "scr_net_data_thunk_dyn"
              : cbT.params[0]!.kind === "string" ? "scr_net_data_thunk_str"
              : "scr_net_data_thunk_bytes";
            emitter.line(`scr_net_sock_on_data(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockOnEnd":
          case "net.sockOnClose":
          case "net.sockOnConnect": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const fn = e.fn === "net.sockOnEnd" ? "scr_net_sock_on_end"
              : e.fn === "net.sockOnClose" ? "scr_net_sock_on_close"
              : "scr_net_sock_on_connect";
            emitter.line(`${fn}(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          // node:dgram + node:dns (scr_dgram.c + the loop's dgram hook —
          // linked only when these appear on the IR). The net discipline:
          // receivers/data borrowed, CALLBACKS MOVE into the handle's
          // registry; bind/connect/send make the loop live (usesTimers).
          case "dgram.createSocket":
            return finish(`scr_dgram_create(${arg(0)})`);
          case "dgram.bind":
            emitter.usesTimers = true; // a bound socket holds the loop open
            return finish(`scr_dgram_bind(${arg(0)}, ${arg(1)}, ${arg(2)}, NULL)`);
          case "dgram.bindCb": {
            emitter.usesTimers = true;
            const cb = args[3]!;
            emitter.moveTemp(cb);
            return finish(`scr_dgram_bind(${arg(0)}, ${arg(1)}, ${arg(2)}, ${cb.name})`);
          }
          case "dgram.connect":
            emitter.usesTimers = true; // a connected socket holds the loop open
            return finish(`scr_dgram_connect(${arg(0)}, ${arg(1)}, ${arg(2)}, NULL)`);
          case "dgram.connectCb": {
            emitter.usesTimers = true;
            const cb = args[3]!;
            emitter.moveTemp(cb);
            return finish(`scr_dgram_connect(${arg(0)}, ${arg(1)}, ${arg(2)}, ${cb.name})`);
          }
          case "dgram.sendStr":
            emitter.usesTimers = true; // send implicit-binds; the socket stays open
            return finish(`scr_dgram_send_str(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "dgram.sendBytes":
            emitter.usesTimers = true;
            return finish(`scr_dgram_send_bytes(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)})`);
          case "dgram.sendChk":
            emitter.usesTimers = true; // a validated send implicit-binds
            return finish(
              `scr_dgram_send_chk(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)})`,
            );
          case "dgram.address": {
            // The AddressInfo record, built here from runtime parts (the
            // frontend pinned the {address, family, port} shape). The
            // address read is the fallible one — Node's "Not running"
            // throw for a never-bound socket; family/port never throw
            // once it passed.
            if (e.type.kind !== "record") throw new InternalCompilerError("emitter bug: dgram.address result is not a record");
            const ip = emitter.fallibleTemp(STRING, `scr_dgram_addr_ip(${arg(0)})`);
            const rec = emitter.newTemp(e.type, `${mangleRecordNew(e.type.shapeId)}()`);
            emitter.moveTemp(ip);
            emitter.line(`${rec.name}->${mangleField("address")} = ${ip.name};`);
            emitter.line(`${rec.name}->${mangleField("family")} = scr_dgram_addr_family(${arg(0)});`);
            emitter.line(`${rec.name}->${mangleField("port")} = scr_dgram_addr_port(${arg(0)});`);
            return rec;
          }
          case "dgram.close":
            return finish(`scr_dgram_close(${arg(0)}, NULL)`);
          case "dgram.closeCb": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            return finish(`scr_dgram_close(${arg(0)}, ${cb.name})`);
          }
          case "dgram.unref":
            emitter.line(`scr_dgram_unref(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "dgram.ref":
            emitter.line(`scr_dgram_ref(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "dgram.onMessage": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: dgram.onMessage callback not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_dgram_msg_thunk0"
              : cbT.params.length === 1 ? "scr_dgram_msg_thunk1"
              : emitter.dgramMsgThunkFor(cbT.params[1]!);
            emitter.line(`scr_dgram_on_message(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "dgram.onError": {
            // The child %Error adapters fit exactly (message → %Error).
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: dgram.onError callback not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            emitter.line(`scr_dgram_on_error(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "dgram.onListening":
          case "dgram.onClose":
          case "dgram.onConnect": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const fn = e.fn === "dgram.onListening" ? "scr_dgram_on_listening"
              : e.fn === "dgram.onClose" ? "scr_dgram_on_close"
              : "scr_dgram_on_connect";
            emitter.line(`${fn}(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "dns.lookup": {
            // getaddrinfo runs NOW; the callback (moved in) fires at the
            // next loop turn through its per-shape adapter.
            emitter.usesTimers = true; // the pending callback holds the loop open
            const cbT = e.args[2]!.type;
            const cb = args[2]!;
            emitter.moveTemp(cb);
            const adapter = emitter.dnsLookupThunkFor(cbT);
            emitter.line(`scr_dns_lookup(${arg(0)}, ${arg(1)}, ${cb.name}, &${adapter});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockEncrypted": {
            // boolean | undefined: the true arm iff the socket carries a
            // TLS transport; plain sockets answer the undefined arm (Node
            // types `encrypted` on TLSSocket only).
            if (e.type.kind !== "union") throw new InternalCompilerError("emitter bug: net.sockEncrypted result is not a union");
            const def = emitter.unionsById.get(e.type.unionId);
            const boolTag = def ? def.arms.findIndex((a) => a.kind === "bool") : -1;
            const undefTag = undefinedArmTag(e.type, emitter.unionsById);
            if (boolTag < 0 || undefTag < 0) {
              throw new InternalCompilerError("emitter bug: net.sockEncrypted union lacks its arms");
            }
            const w = emitter.newTemp(BOOL, `scr_net_sock_encrypted(${arg(0)})`);
            const present = `scr_union_new_bool(${boolTag}, true)`;
            const absent = emitter.unitInstanceRef(e.type.unionId, undefTag);
            return emitter.newTemp(e.type, `${w.name} ? ${present} : ${absent}`);
          }
          case "net.sockDestroyed":
            return finish(`scr_net_sock_destroyed(${arg(0)})`);
          case "net.sockWritable":
            return finish(`scr_net_sock_writable(${arg(0)})`);
          case "net.sockPipeRes":
            emitter.line(`scr_http_sock_pipe_res(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.serverOnListening": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_net_server_on_listening(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockSetEncoding":
            return finish(`scr_net_sock_set_encoding(${arg(0)}, ${arg(1)})`);
          case "net.sockSetTimeout":
            emitter.line(`scr_net_sock_set_timeout(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockOnTimeout": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_net_sock_on_timeout(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockOnReadable": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_net_sock_on_readable(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "net.sockRead": {
            // Buffer | null, type-directed like http.reqHeader: NULL (not
            // enough buffered) takes the null arm.
            if (e.type.kind !== "union") throw new InternalCompilerError("emitter bug: net.sockRead result is not a union");
            const def = emitter.unionsById.get(e.type.unionId);
            const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
            const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
            if (bytesTag < 0 || nullTag < 0) {
              throw new InternalCompilerError("emitter bug: net.sockRead union lacks its arms");
            }
            const b = emitter.newTemp(BYTES_U8, `scr_net_sock_read_bytes(${arg(0)}, ${arg(1)})`);
            emitter.moveTemp(b); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${bytesTag}, ${b.name}, &scr_bytes_retain_v, &scr_bytes_release_v, NULL)`;
            const absent = emitter.unitInstanceRef(e.type.unionId, nullTag);
            return emitter.newTemp(e.type, `${b.name} ? ${present} : ${absent}`);
          }
          case "net.sockUnshift":
            emitter.line(`scr_net_sock_unshift_bytes(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.serverEmitConnection":
            emitter.line(`scr_net_server_emit_connection(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "net.sockRemoteAddress": {
            // string | undefined, type-directed like http.reqHeader: NULL
            // (closed socket) takes the undefined arm.
            if (e.type.kind !== "union") throw new InternalCompilerError("emitter bug: net.sockRemoteAddress result is not a union");
            const def = emitter.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = undefinedArmTag(e.type, emitter.unionsById);
            if (strTag < 0 || undefTag < 0) {
              throw new InternalCompilerError("emitter bug: net.sockRemoteAddress union lacks its arms");
            }
            const s = emitter.newTemp(STRING, `scr_net_sock_remote_address(${arg(0)})`);
            emitter.moveTemp(s);
            const present = `scr_union_new_ref(${strTag}, ${s.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = emitter.unitInstanceRef(e.type.unionId, undefTag);
            return emitter.newTemp(e.type, `${s.name} ? ${present} : ${absent}`);
          }
          case "net.getAutoSelTimeout":
            return finish(`scr_net_get_autosel_timeout()`);
          case "net.setAutoSelTimeout":
            return finish(`scr_net_set_autosel_timeout(${arg(0)})`);
    default:
      throw new InternalCompilerError(`emitter bug: network libCall dispatch for ${fn}`);
  }
}

export function emitHttpLibCall(state: LibCallState): Temp {
  const { e, emitter, args, arg, finish } = state;
  const fn = e.fn;
  switch (fn) {
          // node:http, the server slice (scr_http.c over scr_net.c).
          case "http.createServer": {
            emitter.usesTimers = true;
            const cbT = e.args[0]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.createServer handler not a func");
            const cb = args[0]!;
            emitter.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            return finish(`scr_http_create_server(${cb.name}, &${adapter})`);
          }
          case "http.reqUrl":
            return finish(`scr_http_req_url(${arg(0)})`);
          case "http.reqMethod":
            return finish(`scr_http_req_method(${arg(0)})`);
          case "http.reqHttpVersion":
            return finish(`scr_http_req_http_version(${arg(0)})`);
          case "http.reqHttpVersionMajor":
            return finish(`scr_http_req_http_version_major(${arg(0)})`);
          case "http.reqHttpVersionMinor":
            return finish(`scr_http_req_http_version_minor(${arg(0)})`);
          case "http.reqAborted":
            return finish(`scr_http_req_aborted_flag(${arg(0)})`);
          case "http.reqComplete":
            return finish(`scr_http_req_complete(${arg(0)})`);
          case "http.reqDestroyed": return finish(`scr_http_req_destroyed_flag(${arg(0)})`);
          case "http.reqHeader": {
            // string|undefined, type-directed like process.envGet; NULL takes the undefined arm.
            if (e.type.kind !== "union") throw new InternalCompilerError("emitter bug: http.reqHeader result is not a union");
            const def = emitter.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = undefinedArmTag(e.type, emitter.unionsById);
            if (strTag < 0 || undefTag < 0) {
              throw new InternalCompilerError("emitter bug: http.reqHeader union lacks its arms");
            }
            const s = emitter.newTemp(STRING, `scr_http_req_header(${arg(0)}, ${arg(1)})`);
            emitter.moveTemp(s); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${strTag}, ${s.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = emitter.unitInstanceRef(e.type.unionId, undefTag);
            return emitter.newTemp(e.type, `${s.name} ? ${present} : ${absent}`);
          }
          case "http.reqOnData": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.reqOnData callback not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter =
              cbT.params.length === 0 ? "scr_net_data_thunk0"
              : cbT.params[0]!.kind === "dyn" ? "scr_net_data_thunk_dyn"
              : cbT.params[0]!.kind === "string" ? "scr_net_data_thunk_str"
              : "scr_net_data_thunk_bytes";
            emitter.line(`scr_http_req_on_data(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.reqOnEnd": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_http_req_on_end(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.resSetHeader":
            emitter.line(`scr_http_res_set_header(${arg(0)}, ${arg(1)}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteHead":
            emitter.line(`scr_http_res_write_head(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteHeadN":
            emitter.line(`scr_http_res_write_head_n(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWrite":
            emitter.line(`scr_http_res_write_str(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteBytes":
            emitter.line(`scr_http_res_write_bytes(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resEnd":
            emitter.line(`scr_http_res_end(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resEndStr":
            emitter.line(`scr_http_res_end_str(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resEndBytes":
            emitter.line(`scr_http_res_end_bytes(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteDyn":
            emitter.line(`scr_http_res_write_dynv(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resEndDyn":
            emitter.line(`scr_http_res_end_dynv(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resHeadersSent":
            return finish(`scr_http_res_headers_sent(${arg(0)})`);
          // The server-surface member follow-ups.
          case "http.reqStatusCode": {
            // number | undefined, type-directed like process.columns: the
            // runtime answers a negative status for server requests.
            if (e.type.kind !== "union") throw new InternalCompilerError("emitter bug: http.reqStatusCode result is not a union");
            const def = emitter.unionsById.get(e.type.unionId);
            const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
            const undefTag = undefinedArmTag(e.type, emitter.unionsById);
            if (f64Tag < 0 || undefTag < 0) {
              throw new InternalCompilerError("emitter bug: http.reqStatusCode union lacks its arms");
            }
            const w = emitter.newTemp(F64, `scr_http_req_status(${arg(0)})`);
            const present = `scr_union_new_f64(${f64Tag}, ${w.name})`;
            const absent = emitter.unitInstanceRef(e.type.unionId, undefTag);
            return emitter.newTemp(e.type, `${w.name} >= 0 ? ${present} : ${absent}`);
          }
          case "http.reqSocket":
            return finish(`scr_http_req_socket(${arg(0)})`);
          case "http.reqH2Stream": {
            if (e.type.kind !== "union") throw new InternalCompilerError("emitter bug: http.reqH2Stream result is not a union");
            const def = emitter.unionsById.get(e.type.unionId);
            const streamTag = def ? def.arms.findIndex((a) => a.kind === "http2Stream") : -1;
            const undefTag = undefinedArmTag(e.type, emitter.unionsById);
            if (streamTag < 0 || undefTag < 0) throw new InternalCompilerError("emitter bug: http.reqH2Stream union lacks its arms");
            const st = emitter.newTemp({ kind: "http2Stream" }, `scr_http_req_h2_stream(${arg(0)})`);
            emitter.moveTemp(st);
            const present = `scr_union_new_ref(${streamTag}, ${st.name}, &scr_http2_stream_retain_v, &scr_http2_stream_release_v, NULL)`;
            return emitter.newTemp(e.type, `${st.name} ? ${present} : ${emitter.unitInstanceRef(e.type.unionId, undefTag)}`);
          }
          case "http.reqH2StreamOrThrow":
            return finish(`scr_http_req_h2_stream_or_throw(${arg(0)}, ${arg(1)})`);
          case "http.reqRawHeaders":
            return finish(`scr_http_req_raw_headers(${arg(0)})`);
          case "http.reqHeaderPairs":
            return finish(`scr_http_req_header_pairs(${arg(0)})`);
          case "http.reqStatusMessage": {
            // string | undefined: a reason phrase on client responses,
            // NULL (the undefined arm) on server requests — the
            // sockRemoteAddress shape.
            if (e.type.kind !== "union") throw new InternalCompilerError("emitter bug: http.reqStatusMessage result is not a union");
            const def = emitter.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = undefinedArmTag(e.type, emitter.unionsById);
            if (strTag < 0 || undefTag < 0) {
              throw new InternalCompilerError("emitter bug: http.reqStatusMessage union lacks its arms");
            }
            const m = emitter.newTemp(STRING, `scr_http_req_status_message(${arg(0)})`);
            emitter.moveTemp(m);
            const present = `scr_union_new_ref(${strTag}, ${m.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = emitter.unitInstanceRef(e.type.unionId, undefTag);
            return emitter.newTemp(e.type, `${m.name} ? ${present} : ${absent}`);
          }
          case "http.serverOnUpgrade":
          case "http.clientOnUpgrade": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError(`emitter bug: ${e.fn} listener not a func`);
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter =
              cbT.params.length === 3 ? "scr_http_upgrade_thunk3"
              : cbT.params.length === 2 ? "scr_http_upgrade_thunk2"
              : cbT.params.length === 1 ? "scr_http_upgrade_thunk1"
              : "scr_http_upgrade_thunk0";
            const entry = e.fn === "http.serverOnUpgrade"
              ? "scr_http_server_on_upgrade"
              : "scr_http_client_on_upgrade";
            emitter.line(`${entry}(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.serverOnConnect": {
            // The CONNECT handover: the upgrade adapters fit the plain
            // socket-param shapes; a UNION socket slot (the h2 compat
            // listener) takes the emitted per-shape wrapper — the arm's
            // tag is program data.
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.serverOnConnect listener not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const p1 = cbT.params[1];
            const adapter =
              p1 !== undefined && p1.kind === "union"
                ? emitter.connectSockThunkFor(cbT)
                : cbT.params.length === 3 ? "scr_http_upgrade_thunk3"
                : cbT.params.length === 2 ? "scr_http_upgrade_thunk2"
                : cbT.params.length === 1 ? "scr_http_upgrade_thunk1"
                : "scr_http_upgrade_thunk0";
            const h2Def = p1?.kind === "union" ? emitter.unionsById.get(p1.unionId) : undefined;
            const h2Adapter = cbT.params.length >= 2
              ? h2Def?.arms.some((arm) => arm.kind === "httpRes") ? `&${emitter.connectResThunkFor(cbT)}` : "NULL"
              : cbT.params.length === 1 ? "&scr_http_handler_thunk1" : "&scr_http_handler_thunk0";
            emitter.line(`scr_http_server_on_connect(${arg(0)}, ${cb.name}, &${adapter}, ${h2Adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.reqPipeRes":
            emitter.line(`scr_http_req_pipe_res(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqPipeClient":
            emitter.line(`scr_http_req_pipe_client(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqPipeSock":
            emitter.line(`scr_http_req_pipe_sock(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqResume":
            emitter.line(`scr_http_req_resume(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqDestroy":
            emitter.line(`scr_http_req_destroy(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.reqOnError": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.reqOnError callback not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            emitter.line(`scr_http_req_on_error(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.reqOnClose": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_http_req_on_close(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.reqOnAborted": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_http_req_on_aborted(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.resDestroy":
            emitter.line(`scr_http_res_destroy(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resOnClose": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_http_res_on_close(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.createServerEmpty":
            emitter.usesTimers = true;
            return finish(`scr_http_create_server(NULL, NULL)`);
          case "http.serverJoinDupHeaders":
            emitter.line(`scr_http_server_join_duplicate_headers(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.serverMaxHeaderSizeSet":
            return finish(`scr_http_server_max_header_size_set(${arg(0)}, ${arg(1)})`);
          case "http.serverTimeoutGet":
            return finish(`scr_net_server_timeout_get(${arg(0)}, ${arg(1)})`);
          case "http.serverTimeoutSet":
            emitter.line(`scr_net_server_timeout_set(${arg(0)}, ${arg(1)}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.serverTimeoutOptionSet":
            return finish(`scr_net_server_timeout_option_set(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "http.resStatusGet":
            return finish(`scr_http_res_status_get(${arg(0)})`);
          case "http.resStatusSet":
            emitter.line(`scr_http_res_status_set(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resStatusMsgGet":
            return finish(`scr_http_res_status_msg_get(${arg(0)})`);
          case "http.resStatusMsgSet":
            emitter.line(`scr_http_res_status_msg_set(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resGetHeader": {
            // string|undefined, exactly the http.reqHeader emission.
            if (e.type.kind !== "union") throw new InternalCompilerError("emitter bug: http.resGetHeader result is not a union");
            const def = emitter.unionsById.get(e.type.unionId);
            const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
            const undefTag = undefinedArmTag(e.type, emitter.unionsById);
            if (strTag < 0 || undefTag < 0) {
              throw new InternalCompilerError("emitter bug: http.resGetHeader union lacks its arms");
            }
            const s = emitter.newTemp(STRING, `scr_http_res_get_header(${arg(0)}, ${arg(1)})`);
            emitter.moveTemp(s); // moves into the box when present; NULL otherwise
            const present = `scr_union_new_ref(${strTag}, ${s.name}, &scr_str_retain_v, &scr_str_release_v, NULL)`;
            const absent = emitter.unitInstanceRef(e.type.unionId, undefTag);
            return emitter.newTemp(e.type, `${s.name} ? ${present} : ${absent}`);
          }
          case "http.resHasHeader":
            return finish(`scr_http_res_has_header_named(${arg(0)}, ${arg(1)})`);
          case "http.resRemoveHeader":
            emitter.line(`scr_http_res_remove_header(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resOnFinish": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            emitter.line(`scr_http_res_on_finish(${arg(0)}, ${cb.name});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.resWriteHeadPairs":
            emitter.line(`scr_http_res_write_head_pairs(${arg(0)}, ${arg(1)}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.resWriteHeadDyn":
            return finish(`scr_http_res_write_head_dyn(${arg(0)}, ${arg(1)}, ${arg(2)})`);
          case "http.reqSetEncoding":
            return finish(`scr_http_req_set_encoding(${arg(0)}, ${arg(1)})`);
          // node:http, the client slice (scr_http.c over the net client).
          case "http.request":
          case "http.requestCb": {
            emitter.usesTimers = true; // an in-flight request holds the loop open
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "http.requestCb") {
              const cbT = e.args[7]!.type;
              if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.requestCb callback not a func");
              const cb = args[7]!;
              emitter.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `scr_http_request(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${cbExpr}, ${adapter})`,
            );
          }
          case "http.agentNew":
            emitter.usesTimers = true; // queued dials hold the loop open
            return finish(
              `scr_http_agent_new(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)})`,
            );
          case "http.requestAgent":
          case "http.requestAgentCb": {
            emitter.usesTimers = true;
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "http.requestAgentCb") {
              const cbT = e.args[8]!.type;
              if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.requestAgentCb callback not a func");
              const cb = args[8]!;
              emitter.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `scr_http_request_agent(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, ${cbExpr}, ${adapter})`,
            );
          }
          case "http.requestUrl":
          case "http.requestUrlCb":
          case "https.requestUrl":
          case "https.requestUrlCb": {
            emitter.usesTimers = true; // an in-flight request holds the loop open
            const tls = e.fn.startsWith("https.");
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn.endsWith("Cb")) {
              const cbT = e.args[3]!.type;
              if (cbT.kind !== "func") throw new InternalCompilerError(`emitter bug: ${e.fn} callback not a func`);
              const cb = args[3]!;
              emitter.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            const entry = tls ? "scr_https_request_url" : "scr_http_request_url";
            return finish(
              `${entry}(${arg(0)}, ${arg(1)}, ${arg(2)}, ${cbExpr}, ${adapter})`,
            );
          }
          case "http.requestConn":
          case "http.requestConnCb": {
            emitter.usesTimers = true;
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "http.requestConnCb") {
              const cbT = e.args[6]!.type;
              if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.requestConnCb callback not a func");
              const cb = args[6]!;
              emitter.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            const dial = args[0]!;
            emitter.moveTemp(dial);
            return finish(
              `scr_http_request_conn(${dial.name}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${cbExpr}, ${adapter})`,
            );
          }
          case "https.createServer": {
            emitter.usesTimers = true;
            const cbT = e.args[2]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: https.createServer handler not a func");
            const cb = args[2]!;
            emitter.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            return finish(
              `scr_https_create_server((const char *)${arg(0)}->data, ${arg(0)}->len, (const char *)${arg(1)}->data, ${arg(1)}->len, ${cb.name}, &${adapter})`,
            );
          }
          case "https.createServerDyn":
            emitter.usesTimers = true;
            return finish(`scr_https_create_server_dyn(${arg(0)}, NULL, NULL)`);
          case "https.createServerDynCb": {
            emitter.usesTimers = true;
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: https.createServerDynCb handler not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            return finish(`scr_https_create_server_dyn(${arg(0)}, ${cb.name}, &${adapter})`);
          }
          case "http.serverOnRequest": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.serverOnRequest handler not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter =
              cbT.params.length === 2 ? "scr_http_handler_thunk2"
              : cbT.params.length === 1 ? "scr_http_handler_thunk1"
              : "scr_http_handler_thunk0";
            emitter.line(`scr_http_server_on_request(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "https.request":
          case "https.requestCb": {
            emitter.usesTimers = true; // an in-flight request holds the loop open
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "https.requestCb") {
              const cbT = e.args[9]!.type;
              if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: https.requestCb callback not a func");
              const cb = args[9]!;
              emitter.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `scr_https_request(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, (const char *)${arg(8)}->data, ${arg(8)}->len, ${cbExpr}, ${adapter})`,
            );
          }
          case "https.requestAgent":
          case "https.requestAgentCb": {
            emitter.usesTimers = true; // an in-flight request holds the loop open
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "https.requestAgentCb") {
              const cbT = e.args[10]!.type;
              if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: https.requestAgentCb callback not a func");
              const cb = args[10]!;
              emitter.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `scr_https_request_agent(${arg(0)}, ${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, (const char *)${arg(8)}->data, ${arg(8)}->len, ${arg(9)}, ${cbExpr}, ${adapter})`,
            );
          }
          case "https.requestFn":
          case "https.requestFnCb": {
            // The requestFn binding's runtime dial: arg 0 picks the client
            // — a C ternary between the two real entry points over the
            // SAME evaluated argument temps (only one side runs; the cb
            // moves into whichever). The https row's reject/ca args are
            // simply unused on the plain side, like Node's http.request
            // with TLS options.
            emitter.usesTimers = true; // an in-flight request holds the loop open
            let cbExpr = "NULL";
            let adapter = "NULL";
            if (e.fn === "https.requestFnCb") {
              const cbT = e.args[10]!.type;
              if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: https.requestFnCb callback not a func");
              const cb = args[10]!;
              emitter.moveTemp(cb);
              cbExpr = cb.name;
              adapter = cbT.params.length === 0 ? "&scr_http_resp_thunk0" : "&scr_http_resp_thunk_res";
            }
            return finish(
              `(${arg(0)} ? scr_https_request(${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, ${arg(8)}, (const char *)${arg(9)}->data, ${arg(9)}->len, ${cbExpr}, ${adapter}) : scr_http_request_ex(${arg(1)}, ${arg(2)}, ${arg(3)}, ${arg(4)}, ${arg(5)}, ${arg(6)}, ${arg(7)}, ${cbExpr}, ${adapter}, 80, NULL, NULL))`,
            );
          }
          case "http.clientWrite":
            emitter.line(`scr_http_client_write_str(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientWriteBytes":
            emitter.line(`scr_http_client_write_bytes(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientEnd":
            emitter.line(`scr_http_client_end(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientEndStr":
            emitter.line(`scr_http_client_end_str(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientEndBytes":
            emitter.line(`scr_http_client_end_bytes(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientWriteDyn":
            emitter.line(`scr_http_client_write_dynv(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientEndDyn":
            emitter.line(`scr_http_client_end_dynv(${arg(0)}, ${arg(1)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientDestroy":
            emitter.line(`scr_http_client_destroy(${arg(0)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          case "http.clientDestroyed":
            return finish(`scr_http_client_destroyed(${arg(0)})`);
          case "http.clientOnResponse": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.clientOnResponse callback not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_http_resp_thunk0" : "scr_http_resp_thunk_res";
            emitter.line(`scr_http_client_on_response(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.clientOnError": {
            const cbT = e.args[1]!.type;
            if (cbT.kind !== "func") throw new InternalCompilerError("emitter bug: http.clientOnError callback not a func");
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
            emitter.line(`scr_http_client_on_error(${arg(0)}, ${cb.name}, &${adapter}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
          case "http.clientOnTimeout":
          case "http.clientOnClose": {
            const cb = args[1]!;
            emitter.moveTemp(cb);
            const fn = e.fn === "http.clientOnTimeout" ? "scr_http_client_on_timeout" : "scr_http_client_on_close";
            emitter.line(`${fn}(${arg(0)}, ${cb.name}, ${arg(2)});${emitter.srcComment(e.loc)}`);
            return { name: "", type: e.type };
          }
    default:
      throw new InternalCompilerError(`emitter bug: http libCall dispatch for ${fn}`);
  }
}
