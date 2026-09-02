/* node:readline — the question/nextLine/close slice over the stdin unit
 * (scr_events.c), linked exactly when the program uses it (the events
 * gating; rl.* libCalls imply events).
 *
 * Model, pinned against Node under pipes (SEMANTICS.md + corpus 1475):
 * - createInterface({ input: process.stdin, output: process.stdout })
 *   registers this unit's ONE shared stdin data listener (a consumer: the
 *   loop watches fd 0 and the process stays alive while any interface is
 *   open, exactly Node's un-closed readline) and a global 'end' listener.
 * - Lines split on \n and \r\n (and a bare \r followed by more input);
 *   a trailing \r holds until the next chunk decides \r\n vs \r.
 * - question(query, cb) writes the query to stdout (Node writes it under
 *   pipes too) and delivers the NEXT line's text; a line arriving with no
 *   pending question is DROPPED (Node emits 'line' that nobody hears).
 * - close() removes the consumer (the loop stops waiting on fd 0), drops
 *   a pending question (its callback never fires), and fires the 'close'
 *   listeners SYNCHRONOUSLY — Node's close() emits inline, which is why
 *   the portless prompt's close-listener resolve wins over the question
 *   callback's (oracle-pinned).
 * - nextLine() is `for await (const line of rl)`: it answers the next
 *   line, or UNDEFINED once the interface is closed or stdin ended, and
 *   goes on answering undefined at every later call so the loop ends
 *   (Node's iterator keeps returning {done: true}). This is the one
 *   consumer that OUTLIVES its lines: the moment a program asks for one,
 *   a 'line' listener exists in Node's model, so an unclaimed line stops
 *   dropping and QUEUES for the next ask.
 * - stdin EOF closes every open interface: a held \r terminates its line
 *   and answers a pending question; a leftover PARTIAL line reaches the
 *   async iterator but never a question — Node's onend emits 'line'
 *   directly rather than through [kOnLine], and only [kOnLine] answers a
 *   question (probed against Node 24: `printf 'a\nb' | node` delivers "b"
 *   to `for await` and nothing to a pending `question`). Then 'close'
 *   fires.
 * - question() after close() throws Node's ERR_USE_AFTER_CLOSE message;
 *   nextLine() after close() answers undefined instead — a closed
 *   iterator is done, not an error.
 * - An interface created AFTER stdin ended is DEAD (pinned against
 *   Node): a question still writes its prompt, but nothing ever answers
 *   and 'close' never fires — Node's process exits with the question
 *   pending, and the loop exhausts the same way here. A nextLine on a
 *   dead interface answers undefined at once (Node's iterator over an
 *   already-ended input is immediately done). */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void scr_rl_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

typedef struct ScrRl {
  double id;
  bool closed;
  bool dead; /* created after stdin ended: close fires at question() */
  ScrClosure *q_cb; /* pending question's callback (owned), or NULL */
  void (*q_fn)(ScrClosure *, ScrStr *);
  ScrClosure *nl_cb; /* pending nextLine waiter (owned), or NULL */
  void (*nl_fn)(ScrClosure *, ScrStr *); /* a NULL line means undefined */
  bool iterating; /* a nextLine has been asked: a 'line' listener exists in
                   * Node's model, so an unclaimed line QUEUES below rather
                   * than dropping */
  ScrStr **lines; /* queued lines (owned) waiting for the next nextLine */
  size_t n_lines, cap_lines;
  ScrClosure **close_cbs; /* owned zero-arg listeners */
  size_t n_close, cap_close;
  char *buf; /* undelivered stdin bytes */
  size_t len, cap;
  struct ScrRl *next;
} ScrRl;

static ScrRl *scr_rls = NULL;
static double scr_rl_next_id = 1;
static size_t scr_rl_open = 0;        /* un-closed, un-dead interfaces */
static ScrClosure *scr_rl_data_cb = NULL; /* the shared consumer (borrowed
                                            * mirror; the registry owns) */
static bool scr_rl_end_registered = false;

static ScrRl *scr_rl_find(double id) {
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->id == id) return rl;
  }
  return NULL;
}

/* ── the async iterator's line queue ──────────────────────────────────
 * Node's `for await (const line of rl)` is an EventEmitter.on('line')
 * iterator: it is a LISTENER, so a line parsed while the loop body is
 * running (between one await settling and the next nextLine) is buffered
 * rather than lost. A question has no such queue — nothing listens
 * between two questions, which is why an unclaimed line still drops for
 * a question-only interface. */

/* Hands a parsed line to the pending nextLine waiter, or queues it.
 * Takes the line's +1 either way. */
static void scr_rl_deliver_line(ScrRl *rl, ScrStr *line) {
  if (rl->nl_cb) {
    ScrClosure *cb = rl->nl_cb;
    void (*fn)(ScrClosure *, ScrStr *) = rl->nl_fn;
    rl->nl_cb = NULL; /* consumed BEFORE the callback runs (once) */
    fn(cb, line);     /* the adapter owns the +1 line */
    scr_closure_release(cb);
    return;
  }
  if (rl->n_lines == rl->cap_lines) {
    rl->cap_lines = rl->cap_lines ? rl->cap_lines * 2 : 4;
    rl->lines = realloc(rl->lines, rl->cap_lines * sizeof *rl->lines);
    if (!rl->lines) scr_rl_oom();
  }
  rl->lines[rl->n_lines++] = line;
}

/* The oldest queued line (+1 moves out), or NULL when none is waiting. */
static ScrStr *scr_rl_take_queued(ScrRl *rl) {
  if (rl->n_lines == 0) return NULL;
  ScrStr *line = rl->lines[0];
  rl->n_lines--;
  memmove(rl->lines, rl->lines + 1, rl->n_lines * sizeof *rl->lines);
  return line;
}

/* Fires the close listeners (snapshot; synchronous, like Node's emit) and
 * releases everything the interface holds. A pending nextLine answers
 * UNDEFINED — the iterator is done, where a pending question simply never
 * hears back. The queue survives: Node's iterator flushes the lines it
 * already heard before reporting done. */
static void scr_rl_settle_close(ScrRl *rl) {
  if (rl->closed) return;
  rl->closed = true;
  if (!rl->dead && scr_rl_open > 0) scr_rl_open--;
  if (rl->q_cb) {
    scr_closure_release(rl->q_cb); /* a pending question never answers */
    rl->q_cb = NULL;
  }
  /* The last open interface leaving detaches the shared consumer so the
   * loop stops waiting on fd 0 (Node's pause-on-close). */
  if (scr_rl_open == 0 && scr_rl_data_cb != NULL) {
    scr_stdin_remove_data(scr_rl_data_cb);
    scr_rl_data_cb = NULL;
  }
  size_t n = rl->n_close;
  ScrClosure **snap = rl->close_cbs;
  rl->close_cbs = NULL;
  rl->n_close = rl->cap_close = 0;
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) {
      ((void (*)(ScrClosure *))snap[i]->fn)(snap[i]);
    }
    scr_closure_release(snap[i]);
  }
  free(snap);
  free(rl->buf);
  rl->buf = NULL;
  rl->len = rl->cap = 0;
  /* The close listeners run first (Node emits 'close' inline), then the
   * parked iterator learns it is done — the fulfillment is a microtask
   * either way, so the listeners' output still comes first. */
  if (rl->nl_cb) {
    ScrClosure *cb = rl->nl_cb;
    void (*fn)(ScrClosure *, ScrStr *) = rl->nl_fn;
    rl->nl_cb = NULL;
    fn(cb, NULL); /* undefined: the iterator is done */
    scr_closure_release(cb);
  }
}

/* One complete line off the front of the buffer: *adv is the byte count
 * consumed (terminator included), *line_len the line's length. False when
 * no complete line is buffered (a trailing \r holds for the \r\n
 * decision). */
static bool scr_rl_scan(const ScrRl *rl, size_t *line_len, size_t *adv) {
  for (size_t i = 0; i < rl->len; i++) {
    char c = rl->buf[i];
    if (c == '\n') {
      *line_len = i;
      *adv = i + 1;
      return true;
    }
    if (c == '\r') {
      if (i + 1 >= rl->len) return false; /* hold: \r\n may straddle chunks */
      *line_len = i;
      *adv = rl->buf[i + 1] == '\n' ? i + 2 : i + 1;
      return true;
    }
  }
  return false;
}

static void scr_rl_drain(ScrRl *rl) {
  size_t line_len, adv;
  while (!rl->closed && scr_rl_scan(rl, &line_len, &adv)) {
    ScrStr *line = NULL;
    ScrClosure *cb = rl->q_cb;
    void (*fn)(ScrClosure *, ScrStr *) = rl->q_fn;
    /* A line is only built for a consumer: a question, the async
     * iterator, or the iterator's queue. */
    if (cb || rl->iterating) line = scr_str_new(rl->buf, line_len);
    memmove(rl->buf, rl->buf + adv, rl->len - adv);
    rl->len -= adv;
    if (cb) {
      rl->q_cb = NULL; /* consumed BEFORE the callback runs (once) */
      fn(cb, line);    /* the adapter owns the +1 line */
      scr_closure_release(cb);
      if (scr_exc_pending()) return;
      continue;
    }
    if (rl->iterating) {
      scr_rl_deliver_line(rl, line); /* the waiter, or the queue */
      if (scr_exc_pending()) return;
      continue;
    }
    /* No consumer at all: the line drops, exactly Node's unheard 'line'. */
  }
}

/* The shared stdin data consumer: appends and drains every open
 * interface (chunks broadcast, like any stdin listener set). */
static void scr_rl_data_adapter(ScrClosure *cb, ScrBytes *chunk) {
  (void)cb;
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->closed || rl->dead) continue;
    if (rl->len + chunk->len > rl->cap) {
      rl->cap = (rl->len + chunk->len) * 2 + 64;
      rl->buf = realloc(rl->buf, rl->cap);
      if (!rl->buf) scr_rl_oom();
    }
    memcpy(rl->buf + rl->len, chunk->data, chunk->len);
    rl->len += chunk->len;
    scr_rl_drain(rl);
    if (scr_exc_pending()) return;
  }
}

/* stdin EOF: every open interface closes. The leftover bytes are one
 * last line — but for WHOM differs, and the split is Node's own: onend
 * emits 'line' DIRECTLY, where the per-chunk path goes through
 * [kOnLine], and only [kOnLine] answers a question. So the async
 * iterator hears the partial line and a pending question does not.
 * The one exception is a HELD \r ("a\r" then EOF): the \r is a real line
 * terminator whose \r\n decision expired, so that line came through the
 * ordinary path and a question does answer it. */
static void scr_rl_end_thunk(ScrClosure *cb) {
  (void)cb;
  scr_rl_data_cb = NULL; /* the stdin unit dropped its listeners itself */
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->closed || rl->dead) continue;
    if (rl->len > 0) {
      bool held_cr = rl->buf[rl->len - 1] == '\r';
      size_t line_len = held_cr ? rl->len - 1 : rl->len;
      if (held_cr && rl->q_cb) {
        /* "a\r" then EOF: the \r terminates the line (Node's crlfDelay
         * expiry collapsed to EOF time). */
        ScrStr *line = scr_str_new(rl->buf, line_len);
        ScrClosure *qcb = rl->q_cb;
        void (*fn)(ScrClosure *, ScrStr *) = rl->q_fn;
        rl->q_cb = NULL;
        rl->len = 0;
        fn(qcb, line);
        scr_closure_release(qcb);
        if (scr_exc_pending()) return;
      } else if (rl->iterating) {
        ScrStr *line = scr_str_new(rl->buf, line_len);
        rl->len = 0;
        scr_rl_deliver_line(rl, line);
        if (scr_exc_pending()) return;
      }
      /* Neither: the partial line is DISCARDED, exactly Node. */
    }
    scr_rl_settle_close(rl);
    if (scr_exc_pending()) return;
  }
}

/* Exit-time cleanup (the events-unit precedent, before the RC audit):
 * whatever an interface still holds — a parked question, close listeners
 * on a dead interface that never asked — releases here. */
static void scr_rl_cleanup_atexit(void) {
  for (ScrRl *rl = scr_rls; rl; rl = rl->next) {
    if (rl->q_cb) {
      scr_closure_release(rl->q_cb);
      rl->q_cb = NULL;
    }
    if (rl->nl_cb) {
      scr_closure_release(rl->nl_cb);
      rl->nl_cb = NULL;
    }
    for (size_t i = 0; i < rl->n_lines; i++) scr_str_release(rl->lines[i]);
    free(rl->lines);
    rl->lines = NULL;
    rl->n_lines = rl->cap_lines = 0;
    for (size_t i = 0; i < rl->n_close; i++) scr_closure_release(rl->close_cbs[i]);
    free(rl->close_cbs);
    rl->close_cbs = NULL;
    rl->n_close = rl->cap_close = 0;
    free(rl->buf);
    rl->buf = NULL;
    rl->len = rl->cap = 0;
  }
}

double scr_rl_create(void) {
  static bool cleanup_registered = false;
  if (!cleanup_registered) {
    cleanup_registered = true;
    atexit(scr_rl_cleanup_atexit);
  }
  ScrRl *rl = calloc(1, sizeof *rl);
  if (!rl) scr_rl_oom();
  rl->id = scr_rl_next_id++;
  rl->next = scr_rls;
  scr_rls = rl;
  if (scr_stdin_ended()) {
    rl->dead = true; /* close fires when a question is asked */
    return rl->id;
  }
  scr_rl_open++;
  if (scr_rl_data_cb == NULL) {
    /* One shared consumer + one global end hook. The closures carry no
     * captures; their fn slots are never invoked directly for the data
     * one (the registered adapter is), and the end one IS its thunk. */
    scr_rl_data_cb = scr_closure_new((void *)&scr_rl_data_adapter, 0);
    scr_stdin_on_data(scr_rl_data_cb, &scr_rl_data_adapter, false);
  }
  if (!scr_rl_end_registered) {
    scr_rl_end_registered = true;
    scr_stdin_on_end(scr_closure_new((void *)&scr_rl_end_thunk, 0), false);
  }
  return rl->id;
}

void scr_rl_question(double id, const ScrStr *query, ScrClosure *cb /*moves*/,
                      void (*fn)(ScrClosure *, ScrStr *)) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_closure_release(cb);
    /* Node's ERR_USE_AFTER_CLOSE. */
    scr_throw_error_msg(SCR_ERR_ERROR, "readline was closed", 19);
    return;
  }
  /* The prompt writes to stdout under pipes too (Node's question does), and
   * must be visible before input arrives even though it has no trailing
   * newline. */
  scr_stdio_write(1, query->data, query->len);
  if (rl->dead) {
    /* Created after stdin ended: pinned against Node — the prompt still
     * writes, but the DESTROYED stream delivers nothing and 'close'
     * never fires (Node's process exits with the question pending; the
     * loop exhausts the same way here). The callback releases now. */
    scr_closure_release(cb);
    return;
  }
  if (rl->q_cb) scr_closure_release(rl->q_cb); /* re-ask replaces (Node) */
  rl->q_cb = cb;
  rl->q_fn = fn;
  scr_rl_drain(rl); /* an already-buffered line answers immediately */
}

/* `for await (const line of rl)`: the next line, or NULL for undefined.
 *
 * Unlike question, this NEVER throws on a closed interface — a done
 * iterator answers undefined, and answers it again at every later call,
 * which is what ends the loop. The three prompt answers, in order: a line
 * the queue already holds, a line already buffered in the byte window
 * (scr_rl_drain, exactly question's immediate answer), or undefined when
 * nothing more can arrive. Otherwise the waiter parks and the loop keeps
 * fd 0 alive, because the interface is still an open stdin consumer. */
void scr_rl_next_line(double id, ScrClosure *cb /*moves*/,
                      void (*fn)(ScrClosure *, ScrStr *)) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) {
    fn(cb, NULL);
    scr_closure_release(cb);
    return;
  }
  rl->iterating = true; /* from here on, unclaimed lines queue */
  ScrStr *queued = scr_rl_take_queued(rl);
  if (queued) {
    fn(cb, queued);
    scr_closure_release(cb);
    return;
  }
  if (rl->closed || rl->dead) {
    fn(cb, NULL);
    scr_closure_release(cb);
    return;
  }
  if (rl->nl_cb) scr_closure_release(rl->nl_cb); /* re-ask replaces */
  rl->nl_cb = cb;
  rl->nl_fn = fn;
  scr_rl_drain(rl); /* an already-buffered line answers immediately */
}

void scr_rl_close(double id) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl) return;
  scr_rl_settle_close(rl); /* twice is a no-op, like Node */
}

void scr_rl_on_close(double id, ScrClosure *cb /*moves*/) {
  ScrRl *rl = scr_rl_find(id);
  if (!rl || rl->closed) {
    scr_closure_release(cb); /* after 'close' emitted: never fires */
    return;
  }
  if (rl->n_close == rl->cap_close) {
    rl->cap_close = rl->cap_close ? rl->cap_close * 2 : 2;
    rl->close_cbs = realloc(rl->close_cbs, rl->cap_close * sizeof *rl->close_cbs);
    if (!rl->close_cbs) scr_rl_oom();
  }
  rl->close_cbs[rl->n_close++] = cb;
}

/* ── the runtime-provided answer adapters ────────────────────────────── */

/* A zero-param question callback: the answer is ignored. */
void scr_rl_answer_thunk0(ScrClosure *cb, ScrStr *answer) {
  scr_str_release(answer);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* An (answer: string) callback — owns the +1 answer per the universal
 * convention. */
void scr_rl_answer_thunk_str(ScrClosure *cb, ScrStr *answer) {
  ((void (*)(ScrClosure *, ScrStr *))cb->fn)(cb, answer);
}
