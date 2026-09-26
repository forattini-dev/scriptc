/* Standard library: the process global + synchronous node:fs (scr_runtime.h
 * has the API contract). Everything here is called through compiler-emitted
 * `libCall` IR.
 *
 * - process.argv is ONE interned array, built lazily on first read and
 *   retained per read — identity (`process.argv === process.argv`) and
 *   mutation persistence match Node's stable process.argv. The atexit
 *   cleanup registered by scr_lib_init releases the interned values before
 *   the RC audit runs (atexit is LIFO; scr_init registered the audit
 *   first), so they never count as leaks.
 * - fs failures THROW through the exception cell (scr_throw_error — the
 *   payload is a catchable Error instance whose message is shaped like
 *   Node's fs error messages) and return a dummy; the compiler emits
 *   pending checks after every fs call (the MAY_THROW_LIB_FNS seed).
 *   scr_fs_exists never throws, like Node's existsSync.
 */
#include "scr_runtime.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#ifdef _WIN32
/* ── the Windows arm's system surface ─────────────────────────────────
 * mingw-w64's CRT covers most of sync fs (open/read/write/stat/dirent —
 * the seams below note what it lacks: d_type, lstat, two-arg mkdir,
 * mkdtemp, O_SYNC) and the Win32 API covers the process/os surface
 * (GetTempPathA, GetUserNameA, RtlGetVersion, GetConsoleScreenBufferInfo).
 * What has NO arm yet is stubbed honestly at its seam: process.kill and
 * getuid/getgid (needs-design: OpenProcess/TerminateProcess vs Node's
 * uv_kill; no uids exist on Windows — Node omits the members there),
 * setRawMode's raw arm (mechanical: SetConsoleMode).
 * os.networkInterfaces HAS its arm: GetAdaptersAddresses below, libuv's
 * exact row selection. */
#include <direct.h>  /* _mkdir */
#include <io.h>      /* _isatty, _access, open/read/write/close */
#include <process.h> /* getpid */
#include <unistd.h>  /* mingw-w64 ships one: getcwd, access, isatty, ... */
#include <winsock2.h> /* BEFORE windows.h (which pulls winsock 1 otherwise) */
#include <ws2tcpip.h> /* inet_ntop, sockaddr_in6 */
#include <iphlpapi.h> /* GetAdaptersAddresses (os.networkInterfaces) */
#include <windows.h>
#include <winioctl.h> /* FSCTL_GET_REPARSE_POINT */
#include <lmcons.h>  /* UNLEN for GetUserNameA */
#include "scr_win_stats.h"


/* The CRT has no symlink view, so its internal lstat users degrade to stat.
 * The public Stats path below bypasses this seam and opens the final component
 * as a reparse point for lstatSync, matching Node's no-follow split. */
#define lstat stat

/* Windows has no directory mode bits; the CRT mkdir takes one argument. */
#define scr_sys_mkdir(p, m) ((void)(m), mkdir(p))

/* openSync's "rs"/"sa" flags: no O_SYNC on the CRT — degrade to non-sync
 * opens (Node on Windows maps O_SYNC to FILE_FLAG_WRITE_THROUGH; the
 * difference is durability, not observable output). */
#define O_SYNC 0

#ifndef INET6_ADDRSTRLEN
#define INET6_ADDRSTRLEN 46 /* ws2tcpip.h's value; only sizes the row bufs */
#endif

#else /* !_WIN32 */

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <pthread.h>
#include <pwd.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/utsname.h>
#include <termios.h>
#include <unistd.h>
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
#include <net/if_dl.h>
#elif defined(__linux__)
#include <netpacket/packet.h>
#endif

#define scr_sys_mkdir(p, m) mkdir((p), (m))

extern char **environ; /* env snapshot (scr_env_pairs) */

#endif /* _WIN32 */

#include "scr_time.h"

/* O_BINARY: Windows-only (CRT text mode would translate \n on fd writes);
 * zero elsewhere so the POSIX open flags are unchanged. */
#ifndef O_BINARY
#define O_BINARY 0
#endif

/* ── process ─────────────────────────────────────────────────────────── */

static SCR_TL int scr_lib_argc = 0;
static SCR_TL char **scr_lib_argv = NULL;
static SCR_TL ScrArr *scr_argv_arr = NULL;    /* interned process.argv */
static SCR_TL ScrStr *scr_platform_str = NULL; /* interned process.platform */
static SCR_TL ScrStr *scr_exec_path_str = NULL; /* interned process.execPath */
static SCR_TL ScrStr *scr_arch_str = NULL;      /* interned process.arch */
static SCR_TL ScrStr *scr_versions_node_str = NULL; /* interned process.versions.node */
static SCR_TL ScrStr *scr_navigator_user_agent_str = NULL;
static SCR_TL ScrStr *scr_versions_openssl_str = NULL; /* interned process.versions.openssl */

/* Keep lazy process values out of the startup cleanup root.  The executable
 * linker can discard an otherwise-unused getter, but an unconditional atexit
 * callback that mentions every cache would still retain each cache cell (and
 * its symbol) in a tiny hello-world.  Each getter below instead registers its
 * own cleanup only when the value is first materialized.  That is equivalent
 * at process exit and retains the RC-audit cleanup guarantee for the values a
 * program actually observes. */
static void scr_lib_cleanup(void) {
  scr_arr_release(scr_argv_arr);
  scr_argv_arr = NULL;
}

static void scr_process_platform_cleanup(void) {
  scr_str_release(scr_platform_str);
  scr_platform_str = NULL;
}

static void scr_process_exec_path_cleanup(void) {
  scr_str_release(scr_exec_path_str);
  scr_exec_path_str = NULL;
}

static void scr_process_arch_cleanup(void) {
  scr_str_release(scr_arch_str);
  scr_arch_str = NULL;
}

static void scr_process_versions_node_cleanup(void) {
  scr_str_release(scr_versions_node_str);
  scr_versions_node_str = NULL;
}

static void scr_navigator_user_agent_cleanup(void) {
  scr_str_release(scr_navigator_user_agent_str);
  scr_navigator_user_agent_str = NULL;
}

static void scr_process_versions_openssl_cleanup(void) {
  scr_str_release(scr_versions_openssl_str);
  scr_versions_openssl_str = NULL;
}

static bool scr_lib_same_executable_arg(const char *a, const char *b) {
  if (strcmp(a, b) == 0) return true;
#ifdef __wasi__
  /* WASI has no host executable identity or process-spawning API. */
  return false;
#else
  char resolved_a[PATH_MAX], resolved_b[PATH_MAX];
#ifdef _WIN32
  const char *use_a = _fullpath(resolved_a, a, sizeof resolved_a) != NULL ? resolved_a : a;
  const char *use_b = _fullpath(resolved_b, b, sizeof resolved_b) != NULL ? resolved_b : b;
  return _stricmp(use_a, use_b) == 0;
#else
  const char *use_a = realpath(a, resolved_a) != NULL ? resolved_a : a;
  const char *use_b = realpath(b, resolved_b) != NULL ? resolved_b : b;
  return strcmp(use_a, use_b) == 0;
#endif
#endif
}

/* A child_process call spelling Node's self-reexec shape:
 * spawn(process.execPath, [process.argv[1], ...args]). The parent still
 * knows these two path-like arguments are the executable and script marker,
 * so its argv builder can collapse the marker without guessing from an
 * unrelated child's raw user arguments. Library sessions have no argv and
 * always answer false. */
bool scr_lib_should_collapse_reexec_arg(ScrStr *cmd, ScrArr *args) {
  if (scr_lib_argv == NULL || scr_lib_argc < 1 || scr_arr_len(args) < 1) return false;
  ScrStr *first = (ScrStr *)scr_arr_get_ref(args, 0);
  bool collapse = scr_lib_same_executable_arg(cmd->data, scr_lib_argv[0]) &&
                  scr_lib_same_executable_arg(first->data, scr_lib_argv[0]);
  scr_str_release(first);
  return collapse;
}

#ifndef SCR_LIB
/* Executable lane only: a library artifact has no argv and registers no
 * atexit handlers (the emitted library init never calls this; keeping it out
 * the archive's objects free of any atexit reference — the K8 ambient
 * audit's bar). */
void scr_lib_init(int argc, char **argv) {
  scr_lib_argc = argc;
  scr_lib_argv = argv;
  atexit(scr_lib_cleanup);
}
#endif /* !SCR_LIB */

#ifdef SCR_LIB
/* Library builds never call scr_lib_init (a library artifact has no argv and registers no
 * atexit handlers); the interned process values above still intern lazily
 * on first read, so the library reset seam releases them here instead —
 * scr_library_reset (scr_library.c) calls this every session reset. */
void scr_lib_session_cleanup(void) {
  scr_lib_cleanup();
  scr_process_platform_cleanup();
  scr_process_exec_path_cleanup();
  scr_process_arch_cleanup();
  scr_process_versions_node_cleanup();
  scr_navigator_user_agent_cleanup();
  scr_process_versions_openssl_cleanup();
}
#endif

/* Raw argv accessors for the island's process shim (scr_island.c): the
 * island's process.argv must match the static world's ["scriptc",
 * argv[0], ...] shape exactly, so both build from the same stash. */
int scr_lib_arg_count(void) { return scr_lib_argc; }
const char *scr_lib_arg(int i) { return scr_lib_argv[i]; }

ScrArr *scr_process_argv(void) {
  if (!scr_argv_arr) {
    /* ["scriptc", argv[0], argv[1], ...]: positions and length line up
     * with Node's [node-path, script-path, ...args]; the argv[0]/argv[1]
     * VALUES diverge (SEMANTICS.md). */
    int argc = scr_lib_arg_count();
    scr_argv_arr = scr_arr_new(SCR_ELEM_STR, (size_t)argc + 1);
    scr_arr_push_ref(scr_argv_arr, scr_str_new("scriptc", 7));
    for (int i = 0; i < argc; i++) {
      const char *a = scr_lib_arg(i);
      scr_arr_push_ref(scr_argv_arr, scr_str_new(a, strlen(a)));
    }
  }
  return scr_arr_retain(scr_argv_arr);
}

ScrStr *scr_process_platform(void) {
  if (!scr_platform_str) {
#if defined(__APPLE__)
    scr_platform_str = scr_str_new("darwin", 6);
#elif defined(__linux__)
    scr_platform_str = scr_str_new("linux", 5);
#elif defined(__wasi__)
    scr_platform_str = scr_str_new("wasi", 4);
#elif defined(_WIN32)
    scr_platform_str = scr_str_new("win32", 5);
#else
    scr_platform_str = scr_str_new("unknown", 7);
#endif
#ifndef SCR_LIB
    atexit(scr_process_platform_cleanup);
#endif
  }
  return scr_str_retain(scr_platform_str);
}

/* process.arch — the compiled binary's OWN architecture, spelled the way
 * Node spells its own build's arch. Interned like process.platform. */
ScrStr *scr_process_arch(void) {
  if (!scr_arch_str) {
#if defined(__wasm32__)
    scr_arch_str = scr_str_new("wasm32", 6);
#elif defined(__wasm64__)
    scr_arch_str = scr_str_new("wasm64", 6);
#elif defined(__aarch64__) || defined(_M_ARM64)
    scr_arch_str = scr_str_new("arm64", 5);
#elif defined(__x86_64__) || defined(_M_X64)
    scr_arch_str = scr_str_new("x64", 3);
#else
    scr_arch_str = scr_str_new("unknown", 7);
#endif
#ifndef SCR_LIB
    atexit(scr_process_arch_cleanup);
#endif
  }
  return scr_str_retain(scr_arch_str);
}

/* process.versions.node — the runtime's Node COMPATIBILITY TARGET. There
 * is no Node under a compiled binary; this is the version whose semantics
 * SEMANTICS.md verifies the runtime against (divergence 60, the execPath
 * stance: answer for the world that actually exists). */
#define SCR_NODE_COMPAT_MAJOR "24"
#define SCR_NODE_COMPAT_VERSION SCR_NODE_COMPAT_MAJOR ".0.0"
ScrStr *scr_process_versions_node(void) {
  if (!scr_versions_node_str) {
    scr_versions_node_str =
        scr_str_new(SCR_NODE_COMPAT_VERSION, sizeof(SCR_NODE_COMPAT_VERSION) - 1);
#ifndef SCR_LIB
    atexit(scr_process_versions_node_cleanup);
#endif
  }
  return scr_str_retain(scr_versions_node_str);
}

ScrStr *scr_navigator_user_agent(void) {
  static const char value[] = "Node.js/" SCR_NODE_COMPAT_MAJOR;
  if (!scr_navigator_user_agent_str) {
    scr_navigator_user_agent_str = scr_str_new(value, sizeof(value) - 1);
#ifndef SCR_LIB
    atexit(scr_navigator_user_agent_cleanup);
#endif
  }
  return scr_str_retain(scr_navigator_user_agent_str);
}

/* process.versions.openssl — the compat target's crypto-provider version
 * string (the versions.node stance): Boolean(process.versions.openssl) is
 * Node's own "is crypto available" idiom, and the runtime DOES ship a
 * crypto module (mbedTLS-backed; unsupported members fence at their call
 * sites). Reading undefined here made every hasCrypto test self-skip —
 * measuring nothing (SEMANTICS.md; the divergence entry documents that
 * the string names the compat target's OpenSSL, not a linked library). */
#define SCR_OPENSSL_COMPAT_VERSION "3.5.5"
ScrStr *scr_process_versions_openssl(void) {
  if (!scr_versions_openssl_str) {
    scr_versions_openssl_str =
        scr_str_new(SCR_OPENSSL_COMPAT_VERSION, sizeof(SCR_OPENSSL_COMPAT_VERSION) - 1);
#ifndef SCR_LIB
    atexit(scr_process_versions_openssl_cleanup);
#endif
  }
  return scr_str_retain(scr_versions_openssl_str);
}

/* process.execPath — the running binary's own resolved absolute path,
 * exactly what Node computes for ITS executable (uv_exepath + realpath):
 * _NSGetExecutablePath on macOS, /proc/self/exe on Linux, argv[0] as the
 * last resort. Interned like process.platform; +1 per read. */
ScrStr *scr_process_exec_path(void) {
  if (!scr_exec_path_str) {
    char raw[4096];
    raw[0] = '\0';
#if defined(__APPLE__)
    uint32_t size = sizeof(raw);
    extern int _NSGetExecutablePath(char *buf, uint32_t *bufsize);
    if (_NSGetExecutablePath(raw, &size) != 0) raw[0] = '\0';
#elif defined(__linux__)
    ssize_t got = readlink("/proc/self/exe", raw, sizeof(raw) - 1);
    if (got > 0) raw[got] = '\0';
    else raw[0] = '\0';
#elif defined(_WIN32)
    /* uv_exepath's source of truth on Windows; already absolute, and
     * spelled with backslashes like Node's own execPath there. */
    DWORD got = GetModuleFileNameA(NULL, raw, sizeof(raw) - 1);
    raw[got < sizeof(raw) ? got : 0] = '\0';
#endif
    if (raw[0] == '\0' && scr_lib_argc > 0) {
      snprintf(raw, sizeof(raw), "%s", scr_lib_argv[0]);
    }
#ifdef _WIN32
    char resolved[PATH_MAX];
    const char *use = _fullpath(resolved, raw, sizeof resolved) != NULL ? resolved : raw;
#elif defined(__wasi__)
    /* The host supplies the module's path in the guest namespace as argv[0]. */
    const char *use = raw;
#else
    char resolved[PATH_MAX];
    const char *use = realpath(raw, resolved) != NULL ? resolved : raw;
#endif
    scr_exec_path_str = scr_str_new(use, strlen(use));
#ifndef SCR_LIB
    atexit(scr_process_exec_path_cleanup);
#endif
  }
  return scr_str_retain(scr_exec_path_str);
}

ScrStr *scr_env_get(const ScrStr *name) {
  /* ScrStr data is NUL-terminated (like the fs paths below). A fresh copy
   * per read: getenv's buffer is not ours to alias, and Node's process.env
   * reads snapshot the value too. Absent → NULL (the compiler's undefined
   * arm), never a throw. */
#ifdef _WIN32
  /* The WIN32 environment, not the CRT's startup snapshot — libuv's choice
   * too, and the one CreateProcess children inherit. Case-insensitive,
   * like Node's process.env on Windows. */
  DWORD need = GetEnvironmentVariableA(name->data, NULL, 0);
  if (need == 0) return NULL; /* absent (an empty value still needs its NUL) */
  char *buf = malloc(need);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  DWORD got = GetEnvironmentVariableA(name->data, buf, need);
  ScrStr *s = scr_str_new(buf, got);
  free(buf);
  return s;
#else
  const char *v = getenv(name->data);
  return v ? scr_str_new(v, strlen(v)) : NULL;
#endif
}

/* process.env.NAME = v — setenv(3): later scr_env_get reads and spawned
 * children (posix_spawn inherits environ) observe the write, like Node.
 * Both args borrowed (NUL-terminated ScrStr data); setenv copies. */
void scr_env_set(const ScrStr *name, const ScrStr *value) {
#ifdef _WIN32
  /* The WIN32 environment (see scr_env_get): an empty value stays a
   * present-but-empty variable, and children inherit the write. */
  SetEnvironmentVariableA(name->data, value->data);
#else
  setenv(name->data, value->data, 1);
#endif
}

/* `delete process.env.NAME` — unsetenv(3): later reads answer absent and
 * spawned children lose the variable, like Node. Borrowed. */
void scr_env_unset(const ScrStr *name) {
#ifdef _WIN32
  SetEnvironmentVariableA(name->data, NULL);
#else
  unsetenv(name->data);
#endif
}

/* The whole environment as one fresh string[] of alternating
 * [k0, v0, k1, v1, ...] entries in environ order — the raw material of the
 * compiler's process.env snapshot record (insertion order = environ order,
 * which is Node's own Object.keys(process.env) order). Entries without '='
 * (not producible by setenv) are skipped; the value is everything after
 * the FIRST '='. +1 array. */
ScrArr *scr_env_pairs(void) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
#ifdef _WIN32
  /* The WIN32 environment block (see scr_env_get): NUL-separated
   * "K=V" entries, double-NUL terminated. Entries whose first byte is
   * '=' are the hidden per-drive cwd variables ("=C:=..."), which libuv
   * (and so Node's process.env) also skips. */
  char *block = GetEnvironmentStringsA();
  if (block != NULL) {
    for (char *e = block; *e != '\0'; e += strlen(e) + 1) {
      const char *eq = strchr(e, '=');
      if (!eq || eq == e) continue;
      scr_arr_push_ref(out, scr_str_new(e, (size_t)(eq - e)));
      scr_arr_push_ref(out, scr_str_new(eq + 1, strlen(eq + 1)));
    }
    FreeEnvironmentStringsA(block);
  }
#else
  for (char **e = environ; *e != NULL; e++) {
    const char *eq = strchr(*e, '=');
    if (!eq || eq == *e) continue;
    scr_arr_push_ref(out, scr_str_new(*e, (size_t)(eq - *e)));
    scr_arr_push_ref(out, scr_str_new(eq + 1, strlen(eq + 1)));
  }
#endif
  return out;
}

/* ── process.pid / process.getuid / process.kill ─────────────────────── */

double scr_process_pid(void) { return (double)getpid(); }

#if defined(_WIN32) || defined(__wasi__)
/* No uids/gids exist on Windows: Node's process object simply has no
 * getuid/getgid members there, so a call is the property-access TypeError
 * below — thrown catchably, exactly what `process.getuid()` does under
 * Windows Node. WASI has no uid/gid process model either. */
double scr_process_getuid(void) {
  scr_throw_error_msg(SCR_ERR_TYPE, "process.getuid is not a function", 32);
  return 0;
}

double scr_process_getgid(void) {
  scr_throw_error_msg(SCR_ERR_TYPE, "process.getgid is not a function", 32);
  return 0;
}
#else
double scr_process_getuid(void) { return (double)getuid(); }

double scr_process_getgid(void) { return (double)getgid(); }
#endif

/* Node's signal-name table (the names uv exposes), resolved to the HOST's
 * numbers via the POSIX constants. Node accepts names with the SIG prefix
 * only. On Windows the C runtime defines only the ANSI six (INT, ILL,
 * ABRT, FPE, SEGV, TERM) plus SIGBREAK — libuv fills in the numbers below
 * for the handful more it emulates, and Node's os.constants.signals shows
 * exactly that union, so the same defines keep the two tables' Windows
 * rows Node-identical; every other row #ifdefs away like SIGIO/SIGINFO
 * always did. */
#ifdef _WIN32
#define SIGHUP 1    /* uv's emulated numbers (uv-win.h) */
#define SIGQUIT 3
#define SIGKILL 9
#define SIGWINCH 28
#endif

static int scr_signal_by_name(const char *name) {
  static const struct { const char *name; int sig; } SIGS[] = {
      {"SIGHUP", SIGHUP},   {"SIGINT", SIGINT},       {"SIGQUIT", SIGQUIT},
      {"SIGILL", SIGILL},   {"SIGABRT", SIGABRT},
      {"SIGIOT", SIGABRT},  {"SIGFPE", SIGFPE},
      {"SIGKILL", SIGKILL}, {"SIGSEGV", SIGSEGV},
      {"SIGTERM", SIGTERM}, {"SIGWINCH", SIGWINCH},
#ifdef SIGTRAP
      {"SIGTRAP", SIGTRAP},
#endif
#ifdef SIGBUS
      {"SIGBUS", SIGBUS},
#endif
#ifdef SIGUSR1
      {"SIGUSR1", SIGUSR1}, {"SIGUSR2", SIGUSR2},
#endif
#ifdef SIGPIPE
      {"SIGPIPE", SIGPIPE},
#endif
#ifdef SIGALRM
      {"SIGALRM", SIGALRM},
#endif
#ifdef SIGCHLD
      {"SIGCHLD", SIGCHLD}, {"SIGCONT", SIGCONT},
      {"SIGSTOP", SIGSTOP}, {"SIGTSTP", SIGTSTP},     {"SIGTTIN", SIGTTIN},
      {"SIGTTOU", SIGTTOU}, {"SIGURG", SIGURG},       {"SIGXCPU", SIGXCPU},
      {"SIGXFSZ", SIGXFSZ}, {"SIGVTALRM", SIGVTALRM}, {"SIGPROF", SIGPROF},
      {"SIGSYS", SIGSYS},
#endif
#ifdef SIGBREAK
      {"SIGBREAK", SIGBREAK},
#endif
#ifdef SIGIO
      {"SIGIO", SIGIO},
#endif
#ifdef SIGINFO
      {"SIGINFO", SIGINFO},
#endif
  };
  for (size_t i = 0; i < sizeof SIGS / sizeof SIGS[0]; i++) {
    if (strcmp(SIGS[i].name, name) == 0) return SIGS[i].sig;
  }
  return -1;
}

/* The table above for other units (scr_child.c's child.kill shares Node's
 * one signal-name story): the resolved number, or -1 for unknown names. */
int scr_signal_from_name(const ScrStr *signal) {
  return scr_signal_by_name(signal->data);
}

/* The reverse walk, for spawnSync's result.signal: the FIRST name with
 * the number wins (SIGABRT precedes its SIGIOT alias — Node's spelling),
 * NULL for numbers outside the table. Static storage; never freed. */
const char *scr_signal_name(int sig) {
  static const struct { const char *name; int signo; } SIGS[] = {
      {"SIGHUP", SIGHUP},   {"SIGINT", SIGINT},       {"SIGQUIT", SIGQUIT},
      {"SIGILL", SIGILL},
#ifdef SIGTRAP
      {"SIGTRAP", SIGTRAP},
#endif
      {"SIGABRT", SIGABRT},
#ifdef SIGBUS
      {"SIGBUS", SIGBUS},
#endif
      {"SIGFPE", SIGFPE},   {"SIGKILL", SIGKILL},
#ifdef SIGUSR1
      {"SIGUSR1", SIGUSR1},
#endif
      {"SIGSEGV", SIGSEGV},
#ifdef SIGUSR2
      {"SIGUSR2", SIGUSR2},
#endif
#ifdef SIGPIPE
      {"SIGPIPE", SIGPIPE},
#endif
#ifdef SIGALRM
      {"SIGALRM", SIGALRM},
#endif
      {"SIGTERM", SIGTERM},
#ifdef SIGCHLD
      {"SIGCHLD", SIGCHLD}, {"SIGCONT", SIGCONT},     {"SIGSTOP", SIGSTOP},
      {"SIGTSTP", SIGTSTP}, {"SIGTTIN", SIGTTIN},     {"SIGTTOU", SIGTTOU},
      {"SIGURG", SIGURG},   {"SIGXCPU", SIGXCPU},     {"SIGXFSZ", SIGXFSZ},
      {"SIGVTALRM", SIGVTALRM}, {"SIGPROF", SIGPROF},
#endif
      {"SIGWINCH", SIGWINCH},
#ifdef SIGSYS
      {"SIGSYS", SIGSYS},
#endif
#ifdef SIGBREAK
      {"SIGBREAK", SIGBREAK},
#endif
#ifdef SIGIO
      {"SIGIO", SIGIO},
#endif
#ifdef SIGINFO
      {"SIGINFO", SIGINFO},
#endif
  };
  for (size_t i = 0; i < sizeof SIGS / sizeof SIGS[0]; i++) {
    if (SIGS[i].signo == sig) return SIGS[i].name;
  }
  return NULL;
}

/* Node validates the pid as an int32 BEFORE kill(2) and throws the
 * ERR_INVALID_ARG_TYPE TypeError with this exact (odd) wording. */
static bool scr_kill_pid_check(double pid) {
  if (pid >= -2147483648.0 && pid <= 2147483647.0 && pid == (double)(long long)pid) {
    return true; /* NaN fails both range comparisons */
  }
  char num[32];
  scr_f64_to_str(pid, num);
  char msg[96];
  int len = snprintf(msg, sizeof msg,
                     "The \"pid\" argument must be of type number. "
                     "Received type number (%s)",
                     num);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
  return false;
}

/* The shared kill(2) tail: signal 0 probes; failure throws Node's terse
 * `kill ESRCH` / `kill EPERM` Error. Returns Node's constant true.
 * Windows: uv_kill's behavior — signal 0 opens the process to probe
 * liveness, anything else is TerminateProcess (no signal exists to
 * deliver; the target dies with exit code 1, exactly Node-on-Windows's
 * process.kill). ESRCH/EPERM map from the open failure. */
#ifdef _WIN32
static int scr_win_kill(int pid, int sig) {
  HANDLE h = OpenProcess(
      sig == 0 ? PROCESS_QUERY_LIMITED_INFORMATION : PROCESS_TERMINATE,
      FALSE, (DWORD)pid);
  if (h == NULL) {
    errno = GetLastError() == ERROR_ACCESS_DENIED ? EPERM : ESRCH;
    return -1;
  }
  BOOL ok = sig == 0 ? TRUE : TerminateProcess(h, 1);
  CloseHandle(h);
  if (!ok) {
    errno = EPERM;
    return -1;
  }
  return 0;
}
#define scr_sys_kill(pid, sig) scr_win_kill((int)(pid), (sig))
#elif defined(__wasi__)
static int scr_wasi_kill(int pid, int sig) {
  (void)pid;
  (void)sig;
  errno = ENOSYS;
  return -1;
}
#define scr_sys_kill(pid, sig) scr_wasi_kill((int)(pid), (sig))
#else
#define scr_sys_kill(pid, sig) kill((pid_t)(pid), (sig))
#endif

static bool scr_kill_send(int pid, int sig) {
  if (scr_sys_kill(pid, sig) == 0) return true;
  const char *name = errno == ESRCH   ? "ESRCH"
                     : errno == EPERM ? "EPERM"
                     : errno == EINVAL ? "EINVAL"
                                       : NULL;
  char msg[32];
  int len;
  if (name) {
    len = snprintf(msg, sizeof msg, "kill %s", name);
    /* Node's errnoException carries code = the errno name. */
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
  } else {
    len = snprintf(msg, sizeof msg, "kill E%d", errno);
    scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)len);
  }
  return false;
}

bool scr_process_kill(double pid, double signum) {
  if (!scr_kill_pid_check(pid)) return false;
  return scr_kill_send((int)pid, (int)signum);
}

bool scr_process_kill_named(double pid, const ScrStr *signal) {
  if (!scr_kill_pid_check(pid)) return false;
  int sig = scr_signal_by_name(signal->data);
  if (sig < 0) {
    /* Node's ERR_UNKNOWN_SIGNAL TypeError. */
    size_t cap = 16 + signal->len + 1;
    char *msg = malloc(cap);
    if (!msg) {
      scr_trap("scriptc: out of memory\n");
    }
    int len = snprintf(msg, cap, "Unknown signal: %s", signal->data);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
    free(msg);
    return false;
  }
  return scr_kill_send((int)pid, sig);
}

ScrStr *scr_process_cwd(void) {
  char buf[4096];
  if (!getcwd(buf, sizeof buf)) {
    scr_trap("scriptc: process.cwd() failed\n");
  }
  return scr_str_new(buf, strlen(buf));
}

/* The raw byte writes use the SAME stdio stream as console, and each call
 * flushes before returning so live consumers see Node's source order without
 * an observable C buffering delay. The boolean is Node's backpressure signal
 * — this synchronous runtime has no queued backpressure, so it is constantly
 * true. */
bool scr_process_stdout_write(const ScrStr *data) {
  scr_stdio_write(1, data->data, data->len);
  return true;
}

bool scr_process_stderr_write(const ScrStr *data) {
  scr_stdio_write(2, data->data, data->len);
  return true;
}

/* The FIRST-CLASS stream write (`output.write(line)` where output is a
 * WritableStream-typed value — the prefixStream idiom): the value is the
 * stream's fd (1 or 2, minted by the process.stdout/stderr reads), and
 * the write dispatches onto the exact stdout/stderr paths above so
 * prompt submission and ordering stay identical. */
bool scr_proc_stream_write(double fd, const ScrStr *data) {
  return (int)fd == 2 ? scr_process_stderr_write(data) : scr_process_stdout_write(data);
}

/* ── os ──────────────────────────────────────────────────────────────
 * os.platform() lowers to scr_process_platform (one implementation).
 * homedir/tmpdir follow libuv's POSIX rules, which Node delegates to.
 */

#ifdef _WIN32
/* uv_os_homedir on Windows: %USERPROFILE% first, then the profile
 * directory API. The env var covers every real session; abort matches
 * the POSIX arm's stance on the unreachable failure. */
ScrStr *scr_os_homedir(void) {
  const char *home = getenv("USERPROFILE");
  if (home && home[0] != '\0') return scr_str_new(home, strlen(home));
  scr_trap("scriptc: os.homedir() failed\n");
}

ScrStr *scr_os_user_name(void) {
  char buf[UNLEN + 1];
  DWORD n = sizeof buf;
  if (!GetUserNameA(buf, &n) || n == 0) {
    scr_trap("scriptc: os.userInfo() failed\n");
  }
  return scr_str_new(buf, n - 1); /* n counts the NUL */
}

ScrStr *scr_os_user_shell(void) {
  /* Node's userInfo().shell is null on Windows; the scriptc surface types
   * it string, so the closest honest spelling is "" (divergence noted in
   * the windows report). */
  return scr_str_new("", 0);
}

ScrStr *scr_os_user_homedir(void) {
  return scr_os_homedir(); /* uv_os_get_passwd reuses uv_os_homedir on win */
}

ScrStr *scr_os_release(void) {
  /* uv_os_uname on Windows: RtlGetVersion (the un-lied-to GetVersionEx),
   * rendered "major.minor.build" — Node answers e.g. "10.0.26100". */
  typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
  RTL_OSVERSIONINFOW info;
  memset(&info, 0, sizeof info);
  info.dwOSVersionInfoSize = sizeof info;
  HMODULE ntdll = GetModuleHandleA("ntdll.dll");
  RtlGetVersionFn fn =
      ntdll ? (RtlGetVersionFn)(void *)GetProcAddress(ntdll, "RtlGetVersion") : NULL;
  if (fn == NULL || fn(&info) != 0) {
    scr_trap("scriptc: os.release() failed\n");
  }
  char buf[64];
  int len = snprintf(buf, sizeof buf, "%lu.%lu.%lu", (unsigned long)info.dwMajorVersion,
                     (unsigned long)info.dwMinorVersion, (unsigned long)info.dwBuildNumber);
  return scr_str_new(buf, (size_t)len);
}

ScrStr *scr_os_hostname(void) {
  char name[256];
  DWORD size = (DWORD)sizeof name;
  if (!GetComputerNameA(name, &size)) {
    scr_trap("scriptc: os.hostname() failed\n");
  }
  return scr_str_new(name, (size_t)size);
}

ScrStr *scr_os_type(void) {
  /* uv_os_uname's sysname on Windows is the constant "Windows_NT". */
  return scr_str_new("Windows_NT", 10);
}

double scr_os_totalmem(void) {
  MEMORYSTATUSEX ms;
  memset(&ms, 0, sizeof ms);
  ms.dwLength = sizeof ms;
  if (!GlobalMemoryStatusEx(&ms)) return 0;
  return (double)ms.ullTotalPhys;
}

ScrStr *scr_os_tmpdir(void) {
  /* GetTempPathA is libuv's source (TMP → TEMP → USERPROFILE → windir),
   * with Node's one-trailing-separator trim. */
  char buf[MAX_PATH + 2];
  DWORD n = GetTempPathA(sizeof buf, buf);
  if (n == 0 || n >= sizeof buf) {
    scr_trap("scriptc: os.tmpdir() failed\n");
  }
  size_t len = n;
  if (len > 1 && (buf[len - 1] == '\\' || buf[len - 1] == '/')) len--;
  return scr_str_new(buf, len);
}
#elif defined(__wasi__)
/* WASI has an inherited environment but no passwd database, uname, or
 * physical-memory query. Keep the useful environment-backed answers and
 * spell the platform explicitly for the rest. */
ScrStr *scr_os_homedir(void) {
  const char *home = getenv("HOME");
  return scr_str_new(home ? home : "", home ? strlen(home) : 0);
}
ScrStr *scr_os_user_name(void) {
  const char *user = getenv("USER");
  return scr_str_new(user ? user : "", user ? strlen(user) : 0);
}
ScrStr *scr_os_user_shell(void) { return scr_str_new("", 0); }
ScrStr *scr_os_user_homedir(void) { return scr_os_homedir(); }
ScrStr *scr_os_release(void) { return scr_str_new("", 0); }
ScrStr *scr_os_hostname(void) { return scr_str_new("", 0); }
ScrStr *scr_os_type(void) { return scr_str_new("WASI", 4); }
double scr_os_totalmem(void) { return 0; }
/* The guest temp namespace is stable across hosts. `scriptc run` preopens
 * the host's /tmp at this path; other WASI hosts can provide the same
 * capability without leaking a host-specific TMPDIR into the module. */
ScrStr *scr_os_tmpdir(void) { return scr_str_new("/tmp", 4); }
#else
ScrStr *scr_os_homedir(void) {
  /* uv_os_homedir: $HOME when set (even empty is "set" only if non-NULL;
   * libuv requires non-empty), else the passwd entry. */
  const char *home = getenv("HOME");
  if (home && home[0] != '\0') return scr_str_new(home, strlen(home));
  struct passwd pw;
  struct passwd *result = NULL;
  char buf[8192];
  if (getpwuid_r(getuid(), &pw, buf, sizeof buf, &result) != 0 || !result || !result->pw_dir) {
    scr_trap("scriptc: os.homedir() failed\n");
  }
  return scr_str_new(result->pw_dir, strlen(result->pw_dir));
}

/* The os.userInfo() field trio — uv_os_get_passwd's slices. One passwd
 * lookup per call (three calls per userInfo record — cheap, no caching
 * to invalidate). Failure aborts: Node throws a system error there, but
 * no compiled program path reaches it for the running uid. */
static const struct passwd *scr_os_passwd(char *buf, size_t cap, struct passwd *pw) {
  struct passwd *result = NULL;
  if (getpwuid_r(getuid(), pw, buf, cap, &result) != 0 || !result) {
    scr_trap("scriptc: os.userInfo() failed\n");
  }
  return result;
}

ScrStr *scr_os_user_name(void) {
  struct passwd pw;
  char buf[8192];
  const struct passwd *r = scr_os_passwd(buf, sizeof buf, &pw);
  return scr_str_new(r->pw_name, strlen(r->pw_name));
}

ScrStr *scr_os_user_shell(void) {
  struct passwd pw;
  char buf[8192];
  const struct passwd *r = scr_os_passwd(buf, sizeof buf, &pw);
  const char *sh = r->pw_shell ? r->pw_shell : "";
  return scr_str_new(sh, strlen(sh));
}

ScrStr *scr_os_user_homedir(void) {
  /* The PASSWD home (pw_dir) — Node's userInfo().homedir, distinct from
   * os.homedir()'s $HOME-first cascade. */
  struct passwd pw;
  char buf[8192];
  const struct passwd *r = scr_os_passwd(buf, sizeof buf, &pw);
  return scr_str_new(r->pw_dir, strlen(r->pw_dir));
}

ScrStr *scr_os_release(void) {
  /* uname(2)'s release field — Node's uv_os_uname()-backed answer. */
  struct utsname u;
  if (uname(&u) != 0) {
    scr_trap("scriptc: os.release() failed\n");
  }
  return scr_str_new(u.release, strlen(u.release));
}

ScrStr *scr_os_hostname(void) {
  char name[256];
  if (gethostname(name, sizeof name) != 0) {
    scr_trap("scriptc: os.hostname() failed\n");
  }
  name[sizeof name - 1] = '\0';
  return scr_str_new(name, strlen(name));
}

ScrStr *scr_os_type(void) {
  /* uname(2)'s sysname field ("Darwin", "Linux") — Node's os.type(). */
  struct utsname u;
  if (uname(&u) != 0) {
    scr_trap("scriptc: os.type() failed\n");
  }
  return scr_str_new(u.sysname, strlen(u.sysname));
}

double scr_os_totalmem(void) {
  /* Total physical memory in bytes (sysconf pages × page size — Darwin
   * and Linux both answer _SC_PHYS_PAGES). */
  long pages = sysconf(_SC_PHYS_PAGES);
  long psize = sysconf(_SC_PAGE_SIZE);
  if (pages <= 0 || psize <= 0) return 0;
  return (double)pages * (double)psize;
}

ScrStr *scr_os_tmpdir(void) {
  /* Node's env cascade, with ONE trailing slash trimmed (never down to
   * nothing: "/" stays "/"). */
  const char *dir = getenv("TMPDIR");
  if (!dir || dir[0] == '\0') dir = getenv("TMP");
  if (!dir || dir[0] == '\0') dir = getenv("TEMP");
  if (!dir || dir[0] == '\0') dir = "/tmp";
  size_t len = strlen(dir);
  if (len > 1 && dir[len - 1] == '/') len--;
  return scr_str_new(dir, len);
}
#endif /* _WIN32 */

/* ── os.networkInterfaces(): the getifaddrs(3) snapshot ────────────────
 * Row selection and field semantics follow libuv (src/unix/bsd-ifaddrs.c),
 * which Node delegates to: an entry contributes a row iff its interface is
 * IFF_UP && IFF_RUNNING, its address is present, and its family is
 * AF_INET/AF_INET6; `internal` is IFF_LOOPBACK; MACs come from the
 * interface's link-level sibling entry (AF_LINK/AF_PACKET, matched by
 * name), all-zeros when there is none; cidr is Node's lib/os.js
 * computation — address/<contiguous netmask prefix>, null when the netmask
 * is non-contiguous (never in practice). Row order is getifaddrs
 * enumeration order, which is also Node's — but Node guarantees no order,
 * so consumers should compare structurally. The emitter walks the snapshot
 * through the accessors below and builds the typed record inline; a
 * getifaddrs failure (effectively unreachable) yields an empty snapshot
 * where Node would throw ERR_SYSTEM_ERROR. */

typedef struct ScrIfaddrRow {
  char name[64];
  char address[INET6_ADDRSTRLEN];
  char netmask[INET6_ADDRSTRLEN];
  char cidr[INET6_ADDRSTRLEN + 5]; /* address + "/128" */
  bool has_cidr;
  char mac[18]; /* "aa:bb:cc:dd:ee:ff" */
  bool internal;
  bool ipv6;
  double scopeid;
} ScrIfaddrRow;

struct ScrIfaddrs {
  size_t n;
  ScrIfaddrRow *rows;
};

#ifdef _WIN32
/* The Windows arm mirrors libuv's uv_interface_addresses (src/win/util.c),
 * which Node delegates to: GetAdaptersAddresses(AF_UNSPEC, INCLUDE_PREFIX
 * + the SKIP_* flags libuv passes), an adapter contributes rows iff
 * OperStatus == IfOperStatusUp and it has a unicast address, the row name
 * is the adapter's FriendlyName (UTF-8), `internal` is the software-
 * loopback interface type, MAC comes from PhysicalAddress (all-zeros when
 * absent — the loopback), the netmask is built from each unicast
 * address's OnLinkPrefixLength, and scopeid is the v6 sockaddr's. cidr is
 * the shared prefix computation below (always contiguous here by
 * construction). A snapshot failure yields the empty dict, the historical
 * stance. */
ScrIfaddrs *scr_os_ifaddrs(void) {
  ScrIfaddrs *s = calloc(1, sizeof *s);
  if (!s) scr_trap("scriptc: out of memory\n");
  ULONG flags = GAA_FLAG_INCLUDE_PREFIX | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
                GAA_FLAG_SKIP_DNS_SERVER;
  ULONG size = 16 * 1024;
  IP_ADAPTER_ADDRESSES *adapters = NULL;
  for (int tries = 0; tries < 4; tries++) {
    adapters = realloc(adapters, size);
    if (!adapters) scr_trap("scriptc: out of memory\n");
    ULONG rc = GetAdaptersAddresses(AF_UNSPEC, flags, NULL, adapters, &size);
    if (rc == ERROR_SUCCESS) break;
    if (rc != ERROR_BUFFER_OVERFLOW) {
      free(adapters);
      s->rows = calloc(1, sizeof *s->rows);
      if (!s->rows) scr_trap("scriptc: out of memory\n");
      return s; /* empty snapshot */
    }
  }
  size_t count = 0;
  for (IP_ADAPTER_ADDRESSES *a = adapters; a != NULL; a = a->Next) {
    if (a->OperStatus != IfOperStatusUp || a->FirstUnicastAddress == NULL) continue;
    for (IP_ADAPTER_UNICAST_ADDRESS *u = a->FirstUnicastAddress; u != NULL; u = u->Next) {
      int fam = u->Address.lpSockaddr->sa_family;
      if (fam == AF_INET || fam == AF_INET6) count++;
    }
  }
  s->rows = calloc(count ? count : 1, sizeof *s->rows);
  if (!s->rows) scr_trap("scriptc: out of memory\n");
  for (IP_ADAPTER_ADDRESSES *a = adapters; a != NULL; a = a->Next) {
    if (a->OperStatus != IfOperStatusUp || a->FirstUnicastAddress == NULL) continue;
    char name[64] = "";
    WideCharToMultiByte(CP_UTF8, 0, a->FriendlyName, -1, name, sizeof name - 1, NULL, NULL);
    char mac[18];
    if (a->PhysicalAddressLength == 6) {
      snprintf(mac, sizeof mac, "%02x:%02x:%02x:%02x:%02x:%02x", a->PhysicalAddress[0],
               a->PhysicalAddress[1], a->PhysicalAddress[2], a->PhysicalAddress[3],
               a->PhysicalAddress[4], a->PhysicalAddress[5]);
    } else {
      snprintf(mac, sizeof mac, "00:00:00:00:00:00");
    }
    bool internal = a->IfType == IF_TYPE_SOFTWARE_LOOPBACK;
    for (IP_ADAPTER_UNICAST_ADDRESS *u = a->FirstUnicastAddress; u != NULL; u = u->Next) {
      int fam = u->Address.lpSockaddr->sa_family;
      if (fam != AF_INET && fam != AF_INET6) continue;
      if (s->n == count) break; /* the topology raced the two passes */
      ScrIfaddrRow *row = &s->rows[s->n++];
      snprintf(row->name, sizeof row->name, "%s", name);
      memcpy(row->mac, mac, sizeof mac);
      row->internal = internal;
      unsigned prefix = u->OnLinkPrefixLength;
      if (fam == AF_INET6) {
        const struct sockaddr_in6 *sa = (const struct sockaddr_in6 *)u->Address.lpSockaddr;
        row->ipv6 = true;
        row->scopeid = (double)sa->sin6_scope_id;
        inet_ntop(AF_INET6, (void *)&sa->sin6_addr, row->address, sizeof row->address);
        unsigned char mask[16];
        if (prefix > 128) prefix = 128;
        for (size_t i = 0; i < 16; i++) {
          unsigned bits = prefix > 8 * i ? prefix - 8 * i : 0;
          mask[i] = bits >= 8 ? 0xff : (unsigned char)(0xff00 >> bits);
        }
        inet_ntop(AF_INET6, mask, row->netmask, sizeof row->netmask);
        row->has_cidr = true;
        snprintf(row->cidr, sizeof row->cidr, "%s/%u", row->address, prefix);
      } else {
        const struct sockaddr_in *sa = (const struct sockaddr_in *)u->Address.lpSockaddr;
        inet_ntop(AF_INET, (void *)&sa->sin_addr, row->address, sizeof row->address);
        if (prefix > 32) prefix = 32;
        uint32_t mask = prefix == 0 ? 0 : 0xffffffffu << (32 - prefix);
        struct in_addr m;
        m.s_addr = htonl(mask);
        inet_ntop(AF_INET, (void *)&m, row->netmask, sizeof row->netmask);
        row->has_cidr = true;
        snprintf(row->cidr, sizeof row->cidr, "%s/%u", row->address, prefix);
      }
    }
  }
  free(adapters);
  return s;
}
#else
/* libuv's uv__ifaddr_exclude for the address pass, plus the explicit
 * INET/INET6 family filter (the only families Node's binding reports). */
static bool scr_ifaddr_row_ok(const struct ifaddrs *ent) {
  if (!((ent->ifa_flags & IFF_UP) && (ent->ifa_flags & IFF_RUNNING))) return false;
  if (ent->ifa_addr == NULL) return false;
  int fam = ent->ifa_addr->sa_family;
  return fam == AF_INET || fam == AF_INET6;
}

/* Node's getCIDR (lib/os.js): the netmask's contiguous 1-bit prefix.
 * Returns -1 for a non-contiguous mask (cidr is then null). */
static int scr_netmask_prefix(const unsigned char *bytes, size_t len) {
  int ones = 0;
  bool zero_seen = false;
  for (size_t i = 0; i < len; i++) {
    unsigned char b = bytes[i];
    for (int bit = 7; bit >= 0; bit--) {
      if (b & (1u << bit)) {
        if (zero_seen) return -1; /* a 1 after a 0: split mask */
        ones++;
      } else {
        zero_seen = true;
      }
    }
  }
  return ones;
}

ScrIfaddrs *scr_os_ifaddrs(void) {
  ScrIfaddrs *s = calloc(1, sizeof *s);
  if (!s) scr_trap("scriptc: out of memory\n");
  struct ifaddrs *addrs = NULL;
  if (getifaddrs(&addrs) != 0) return s;
  size_t count = 0;
  for (struct ifaddrs *ent = addrs; ent != NULL; ent = ent->ifa_next) {
    if (scr_ifaddr_row_ok(ent)) count++;
  }
  s->rows = calloc(count ? count : 1, sizeof *s->rows);
  if (!s->rows) scr_trap("scriptc: out of memory\n");
  for (struct ifaddrs *ent = addrs; ent != NULL; ent = ent->ifa_next) {
    if (!scr_ifaddr_row_ok(ent)) continue;
    ScrIfaddrRow *row = &s->rows[s->n++];
    snprintf(row->name, sizeof row->name, "%s", ent->ifa_name);
    snprintf(row->mac, sizeof row->mac, "00:00:00:00:00:00");
    row->internal = (ent->ifa_flags & IFF_LOOPBACK) != 0;
    unsigned char maskbytes[16];
    size_t masklen = 0;
    if (ent->ifa_addr->sa_family == AF_INET6) {
      const struct sockaddr_in6 *sa = (const struct sockaddr_in6 *)ent->ifa_addr;
      row->ipv6 = true;
      row->scopeid = (double)sa->sin6_scope_id;
      inet_ntop(AF_INET6, &sa->sin6_addr, row->address, sizeof row->address);
      /* A NULL netmask stays zeroed, exactly libuv's memset — "::"/0. */
      struct in6_addr mask;
      memset(&mask, 0, sizeof mask);
      if (ent->ifa_netmask != NULL) {
        mask = ((const struct sockaddr_in6 *)ent->ifa_netmask)->sin6_addr;
      }
      inet_ntop(AF_INET6, &mask, row->netmask, sizeof row->netmask);
      memcpy(maskbytes, &mask, 16);
      masklen = 16;
    } else {
      const struct sockaddr_in *sa = (const struct sockaddr_in *)ent->ifa_addr;
      inet_ntop(AF_INET, &sa->sin_addr, row->address, sizeof row->address);
      struct in_addr mask;
      memset(&mask, 0, sizeof mask);
      if (ent->ifa_netmask != NULL) {
        mask = ((const struct sockaddr_in *)ent->ifa_netmask)->sin_addr;
      }
      inet_ntop(AF_INET, &mask, row->netmask, sizeof row->netmask);
      memcpy(maskbytes, &mask, 4);
      masklen = 4;
    }
    int prefix = scr_netmask_prefix(maskbytes, masklen);
    if (prefix >= 0) {
      row->has_cidr = true;
      snprintf(row->cidr, sizeof row->cidr, "%s/%d", row->address, prefix);
    }
  }
  /* MAC pass: the link-level sibling entry, matched by interface name —
   * every row of that interface gets its physical address. */
  for (struct ifaddrs *ent = addrs; ent != NULL; ent = ent->ifa_next) {
    if (!((ent->ifa_flags & IFF_UP) && (ent->ifa_flags & IFF_RUNNING))) continue;
    if (ent->ifa_addr == NULL) continue;
    const unsigned char *phys = NULL;
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
    if (ent->ifa_addr->sa_family == AF_LINK) {
      const struct sockaddr_dl *sdl = (const struct sockaddr_dl *)ent->ifa_addr;
      if (sdl->sdl_alen == 6) phys = (const unsigned char *)LLADDR(sdl);
    }
#elif defined(__linux__)
    if (ent->ifa_addr->sa_family == AF_PACKET) {
      const struct sockaddr_ll *sll = (const struct sockaddr_ll *)ent->ifa_addr;
      if (sll->sll_halen == 6) phys = sll->sll_addr;
    }
#endif
    if (!phys) continue;
    for (size_t i = 0; i < s->n; i++) {
      if (strcmp(s->rows[i].name, ent->ifa_name) != 0) continue;
      snprintf(s->rows[i].mac, sizeof s->rows[i].mac, "%02x:%02x:%02x:%02x:%02x:%02x",
               phys[0], phys[1], phys[2], phys[3], phys[4], phys[5]);
    }
  }
  freeifaddrs(addrs);
  return s;
}
#endif /* _WIN32 */

size_t scr_os_ifaddrs_count(const ScrIfaddrs *s) { return s->n; }
ScrStr *scr_os_ifaddrs_name(const ScrIfaddrs *s, size_t i) {
  return scr_str_new(s->rows[i].name, strlen(s->rows[i].name));
}
ScrStr *scr_os_ifaddrs_address(const ScrIfaddrs *s, size_t i) {
  return scr_str_new(s->rows[i].address, strlen(s->rows[i].address));
}
ScrStr *scr_os_ifaddrs_netmask(const ScrIfaddrs *s, size_t i) {
  return scr_str_new(s->rows[i].netmask, strlen(s->rows[i].netmask));
}
ScrStr *scr_os_ifaddrs_family(const ScrIfaddrs *s, size_t i) {
  return s->rows[i].ipv6 ? scr_str_new("IPv6", 4) : scr_str_new("IPv4", 4);
}
ScrStr *scr_os_ifaddrs_mac(const ScrIfaddrs *s, size_t i) {
  return scr_str_new(s->rows[i].mac, strlen(s->rows[i].mac));
}
bool scr_os_ifaddrs_internal(const ScrIfaddrs *s, size_t i) { return s->rows[i].internal; }
bool scr_os_ifaddrs_ipv6(const ScrIfaddrs *s, size_t i) { return s->rows[i].ipv6; }
/* +1 cidr string, or NULL for the null arm (split netmask). */
ScrStr *scr_os_ifaddrs_cidr(const ScrIfaddrs *s, size_t i) {
  if (!s->rows[i].has_cidr) return NULL;
  return scr_str_new(s->rows[i].cidr, strlen(s->rows[i].cidr));
}
double scr_os_ifaddrs_scopeid(const ScrIfaddrs *s, size_t i) { return s->rows[i].scopeid; }
void scr_os_ifaddrs_free(ScrIfaddrs *s) {
  free(s->rows);
  free(s);
}

/* The events-unit hooks (scr_events.c fills them at install; NULL in
 * event-free binaries and in the standalone runtime C tests). */
void (*scr_process_exit_hook)(double code) = NULL;
void (*scr_stdin_destroy_hook)(void) = NULL;

static SCR_TL int scr_process_implicit_exit_code = 0;

void scr_process_exit_code_set(double code) {
  uint32_t bits = scr_to_uint32(code);
  scr_process_implicit_exit_code = bits >= UINT32_C(0x80000000)
      ? (int)((double)bits - 4294967296.0)
      : (int)bits;
}

int scr_process_exit_code_get(void) { return scr_process_implicit_exit_code; }

void scr_process_exit(double code) {
  /* Node runs 'exit' listeners on explicit process.exit() too — they run
   * HERE, synchronously, before the teardown-free exit below. The hook is
   * non-NULL only when the events unit is linked (scr_events.c). */
  scr_process_in_exit = true;
  if (scr_process_exit_hook != NULL) scr_process_exit_hook(code);
  /* _Exit skips atexit handlers on purpose: no further code runs (matching
   * Node), and the RC audit is meaningless mid-program (live values are
   * expected). scr_init's flush-at-exit is also skipped — flush here. */
  fflush(stdout);
  _Exit((int)code);
}

/* ── the process introspection statics ────────────────────────────────
 * process.uptime/cpuUsage/threadCpuUsage/resourceUsage/availableMemory/
 * constrainedMemory — plain reads of the process's own clocks and
 * counters in Node's units. uptime anchors at load time (a constructor-
 * attribute monotonic stamp — the binary's own start, which is what
 * "the current Node.js process" means for a compiled program). */
#ifdef _WIN32
#if defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)
/* The uptime anchor belongs to the host PROCESS, not to a library
 * instance. InitOnce keeps the lazy Windows spelling race-free when
 * several thread instances ask for the clock concurrently. */
static INIT_ONCE scr_uptime_once = INIT_ONCE_STATIC_INIT;
static double scr_uptime_t0_ms;
static BOOL CALLBACK scr_uptime_anchor_once(PINIT_ONCE once, PVOID param,
                                             PVOID *ctx) {
  (void)once;
  (void)param;
  (void)ctx;
  scr_uptime_t0_ms = (double)GetTickCount64();
  return TRUE;
}
static void scr_uptime_anchor_init(void) {
  InitOnceExecuteOnce(&scr_uptime_once, scr_uptime_anchor_once, NULL, NULL);
}
#else
static SCR_TL double scr_uptime_t0_ms;
static void scr_uptime_anchor_init(void) { scr_uptime_t0_ms = (double)GetTickCount64(); }
#endif
static double scr_uptime_now_ms(void) { return (double)GetTickCount64(); }
#else
#include <sys/resource.h>
#include <sys/time.h>
#ifdef __APPLE__
#include <mach/mach.h>
#endif
/* A load-time, process-wide anchor: the constructor runs on only the
 * initial thread, while thread-instanced archives are entered from worker
 * threads whose TLS slots would otherwise stay zero. It is immutable once
 * main starts, so sharing it adds no cross-instance mutable state. */
static double scr_uptime_t0_ms;
static double scr_uptime_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}
__attribute__((constructor)) static void scr_uptime_anchor_init(void) {
  scr_uptime_t0_ms = scr_uptime_now_ms();
}
#endif

double scr_process_uptime(void) {
#if defined(_WIN32) && defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)
  scr_uptime_anchor_init();
#elif defined(_WIN32)
  if (scr_uptime_t0_ms == 0) scr_uptime_anchor_init();
#endif
  return (scr_uptime_now_ms() - scr_uptime_t0_ms) / 1000.0;
}

/* perf_hooks performance.now(): milliseconds since the process's own
 * start (Node's timeOrigin anchor), fractional — the same monotonic
 * clock and anchor as uptime, in Node's performance.now units. */
double scr_perf_now(void) {
#if defined(_WIN32) && defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)
  scr_uptime_anchor_init();
#elif defined(_WIN32)
  if (scr_uptime_t0_ms == 0) scr_uptime_anchor_init();
#endif
  return scr_uptime_now_ms() - scr_uptime_t0_ms;
}

#ifdef _WIN32
/* GetProcessTimes/GetThreadTimes answer 100ns units; Node reports µs. */
static double scr_filetime_us(FILETIME ft) {
  ULARGE_INTEGER v;
  v.LowPart = ft.dwLowDateTime;
  v.HighPart = ft.dwHighDateTime;
  return (double)(v.QuadPart / 10);
}

/* A filesystem FILETIME is 100ns ticks since 1601. Match libuv's split into
 * Unix seconds + nanoseconds before doing Node's millisecond arithmetic; the
 * split matters for the last-bit rounding of dates far from the epoch. */
static double scr_filetime_unix_ms(FILETIME ft) {
  ULARGE_INTEGER raw;
  raw.LowPart = ft.dwLowDateTime;
  raw.HighPart = ft.dwHighDateTime;
  int64_t ticks = (int64_t)raw.QuadPart - INT64_C(116444736000000000);
  int64_t sec = ticks / INT64_C(10000000);
  int64_t rem = ticks % INT64_C(10000000);
  if (rem < 0) {
    sec--;
    rem += INT64_C(10000000);
  }
  return (double)sec * 1000.0 + (double)rem / 10000.0;
}
double scr_cpu_user(void) {
  FILETIME c, e, k, u;
  if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) return 0;
  return scr_filetime_us(u);
}
double scr_cpu_system(void) {
  FILETIME c, e, k, u;
  if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) return 0;
  return scr_filetime_us(k);
}
double scr_thread_cpu_user(void) {
  FILETIME c, e, k, u;
  if (!GetThreadTimes(GetCurrentThread(), &c, &e, &k, &u)) return 0;
  return scr_filetime_us(u);
}
double scr_thread_cpu_system(void) {
  FILETIME c, e, k, u;
  if (!GetThreadTimes(GetCurrentThread(), &c, &e, &k, &u)) return 0;
  return scr_filetime_us(k);
}
#else
static double scr_tv_us(struct timeval tv) {
  return (double)tv.tv_sec * 1e6 + (double)tv.tv_usec;
}
double scr_cpu_user(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_SELF, &ru) != 0) return 0;
  return scr_tv_us(ru.ru_utime);
}
double scr_cpu_system(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_SELF, &ru) != 0) return 0;
  return scr_tv_us(ru.ru_stime);
}
#if defined(RUSAGE_THREAD)
double scr_thread_cpu_user(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_THREAD, &ru) != 0) return 0;
  return scr_tv_us(ru.ru_utime);
}
double scr_thread_cpu_system(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_THREAD, &ru) != 0) return 0;
  return scr_tv_us(ru.ru_stime);
}
#elif defined(__APPLE__)
double scr_thread_cpu_user(void) {
  thread_basic_info_data_t info;
  mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
  if (thread_info(mach_thread_self(), THREAD_BASIC_INFO, (thread_info_t)&info, &count) != KERN_SUCCESS) return 0;
  return (double)info.user_time.seconds * 1e6 + (double)info.user_time.microseconds;
}
double scr_thread_cpu_system(void) {
  thread_basic_info_data_t info;
  mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
  if (thread_info(mach_thread_self(), THREAD_BASIC_INFO, (thread_info_t)&info, &count) != KERN_SUCCESS) return 0;
  return (double)info.system_time.seconds * 1e6 + (double)info.system_time.microseconds;
}
#else
/* No per-thread clock on this platform: the process clocks stand in (a
 * single-threaded binary's thread IS the process). */
double scr_thread_cpu_user(void) { return scr_cpu_user(); }
double scr_thread_cpu_system(void) { return scr_cpu_system(); }
#endif
#endif

/* The prev-argument validation: Node checks prevValue.user then
 * prevValue.system and throws the ERR_INVALID_ARG_VALUE RangeError with
 * the received number, catchably. (The frontend guarantees numbers —
 * non-number shapes keep compile fences.) */
static void scr_cpu_prev_check_field(const char *name, double v) {
  if (v >= 0 && v <= 1.7976931348623157e308 && v == v) return; /* finite, non-negative */
  char num[32];
  size_t nlen = scr_f64_to_str(v, num);
  num[nlen] = 0;
  char msg[128];
  int len = snprintf(msg, sizeof msg, "The property 'prevValue.%s' is invalid. Received %s", name, num);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_INVALID_ARG_VALUE");
}

void scr_cpu_prev_validate(double user, double system) {
  scr_cpu_prev_check_field("user", user);
  if (scr_exc_pending()) return;
  scr_cpu_prev_check_field("system", system);
}

double scr_cpu_user_diff(double prev) { return scr_cpu_user() - prev; }
double scr_cpu_system_diff(double prev) { return scr_cpu_system() - prev; }
double scr_thread_cpu_user_diff(double prev) { return scr_thread_cpu_user() - prev; }
double scr_thread_cpu_system_diff(double prev) { return scr_thread_cpu_system() - prev; }

/* process.resourceUsage(): one field by canonical index — Node's names,
 * order, and units (CPU times in µs; maxRSS in kilobytes — uv divides
 * Darwin's bytes by 1024; the rest are getrusage's own counters, zero
 * where the platform never fills them). */
double scr_process_rusage(double idx) {
#if defined(_WIN32) || defined(__wasi__)
  /* uv fills only the CPU times and page-fault/maxRSS slice on Windows;
   * everything else answers 0 — Node's own shape there. */
  switch ((int)idx) {
    case 0: return scr_cpu_user();
    case 1: return scr_cpu_system();
    default: return 0;
  }
#else
  struct rusage ru;
  if (getrusage(RUSAGE_SELF, &ru) != 0) return 0;
  switch ((int)idx) {
    case 0: return scr_tv_us(ru.ru_utime);      /* userCPUTime */
    case 1: return scr_tv_us(ru.ru_stime);      /* systemCPUTime */
    case 2:                                     /* maxRSS (kilobytes) */
#ifdef __APPLE__
      return (double)(ru.ru_maxrss / 1024);
#else
      return (double)ru.ru_maxrss;
#endif
    case 3: return (double)ru.ru_ixrss;         /* sharedMemorySize */
    case 4: return (double)ru.ru_idrss;         /* unsharedDataSize */
    case 5: return (double)ru.ru_isrss;         /* unsharedStackSize */
    case 6: return (double)ru.ru_minflt;        /* minorPageFault */
    case 7: return (double)ru.ru_majflt;        /* majorPageFault */
    case 8: return (double)ru.ru_nswap;         /* swappedOut */
    case 9: return (double)ru.ru_inblock;       /* fsRead */
    case 10: return (double)ru.ru_oublock;      /* fsWrite */
    case 11: return (double)ru.ru_msgsnd;       /* ipcSent */
    case 12: return (double)ru.ru_msgrcv;       /* ipcReceived */
    case 13: return (double)ru.ru_nsignals;     /* signalsCount */
    case 14: return (double)ru.ru_nvcsw;        /* voluntaryContextSwitches */
    case 15: return (double)ru.ru_nivcsw;       /* involuntaryContextSwitches */
    default: return 0;
  }
#endif
}

/* process.availableMemory()/constrainedMemory() — libuv's numbers: the
 * constrained form answers the cgroup cap where one exists (Linux) and 0
 * everywhere else; available is the free-ish byte count. */
double scr_constrained_memory(void) {
#if defined(__linux__)
  FILE *f = fopen("/sys/fs/cgroup/memory.max", "r"); /* cgroup v2 */
  if (f == NULL) f = fopen("/sys/fs/cgroup/memory/memory.limit_in_bytes", "r"); /* v1 */
  if (f == NULL) return 0;
  char buf[64];
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  buf[n] = 0;
  if (n == 0 || buf[0] == 'm') return 0; /* "max" = unconstrained */
  double v = strtod(buf, NULL);
  return v > 0 ? v : 0;
#else
  return 0;
#endif
}

double scr_available_memory(void) {
#if defined(_WIN32)
  MEMORYSTATUSEX ms;
  memset(&ms, 0, sizeof ms);
  ms.dwLength = sizeof ms;
  if (!GlobalMemoryStatusEx(&ms)) return 0;
  return (double)ms.ullAvailPhys;
#elif defined(__APPLE__)
  /* uv_get_available_memory falls back to the free-memory number on
   * Darwin (vm_statistics' free pages). */
  vm_statistics64_data_t vm;
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm, &count) != KERN_SUCCESS) return 0;
  return (double)vm.free_count * (double)vm_page_size;
#elif defined(__linux__)
  /* /proc/meminfo's MemAvailable — the kernel's own availability estimate
   * (what uv reads via sysinfo lacks reclaimable cache). */
  FILE *f = fopen("/proc/meminfo", "r");
  if (f == NULL) return 0;
  char line[128];
  double kb = 0;
  while (fgets(line, sizeof line, f) != NULL) {
    if (sscanf(line, "MemAvailable: %lf kB", &kb) == 1) break;
  }
  fclose(f);
  return kb * 1024.0;
#else
  return 0;
#endif
}

/* process._exiting — true once the exit sequence began (set above and by
 * scr_run_exit_listeners in scr_events.c; the flag lives HERE so reading
 * it never forces the events unit into the link). */
SCR_TL bool scr_process_in_exit = false;

bool scr_process_exiting(void) { return scr_process_in_exit; }

/* umask(2): mask < 0 reads without setting (set 0, restore — umask has no
 * read-only form); otherwise sets and answers the previous mask. */
double scr_process_umask(double mask) {
#ifdef _WIN32
  /* Node on Windows accepts umask() calls; only the low bits matter. */
  int prev;
  if (mask < 0) {
    _umask_s(0, &prev);
    int ignored;
    _umask_s(prev, &ignored);
  } else {
    _umask_s((int)mask, &prev);
  }
  return (double)prev;
#elif defined(__wasi__)
  static SCR_TL mode_t current = 022;
  mode_t prev = current;
  if (mask >= 0) current = (mode_t)mask;
  return (double)prev;
#else
  mode_t prev;
  if (mask < 0) {
    prev = umask(0);
    umask(prev);
  } else {
    prev = umask((mode_t)mask);
  }
  return (double)prev;
#endif
}

void scr_process_chdir(ScrStr *dir) {
#ifdef _WIN32
  if (_chdir(dir->data) != 0) scr_fs_throw(errno, "chdir", dir);
#else
  if (chdir(dir->data) != 0) scr_fs_throw(errno, "chdir", dir);
#endif
}

/* net's process-wide happy-eyeballs attempt budget (Node's
 * getDefaultAutoSelectFamilyAttemptTimeout pair, default 250ms). Lives in
 * the core unit so the knob never forces scr_net.c into the link. */
static SCR_TL double scr_net_autosel_timeout_ms = 250;

double scr_net_get_autosel_timeout(void) { return scr_net_autosel_timeout_ms; }

/* Node's setDefaultAutoSelectFamilyAttemptTimeout: validateInt32(value,
 * 'value', 1), then the sub-10ms floor (Node clamps small budgets to
 * 10ms). Throws ERR_OUT_OF_RANGE catchably. */
void scr_net_set_autosel_timeout(double ms) {
  char recv[48], msg[160];
  if (!(isfinite(ms) && trunc(ms) == ms)) {
    scr_num_received(ms, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"value\" is out of range. It must be an integer. Received %s", recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  if (ms < 1 || ms > 2147483647.0) {
    scr_num_received(ms, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"value\" is out of range. It must be >= 1 && <= 2147483647. Received %s", recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  scr_net_autosel_timeout_ms = ms < 10 ? 10 : ms;
}

/* ── fs error formatting ─────────────────────────────────────────────
 * Node's fs errors read "<ERRNO>: <text>, <syscall> '<path>'"
 * ("ENOENT: no such file or directory, open 'x'"). The common errnos get
 * Node's (libuv's) exact lowercase text; anything exotic falls back to
 * "E<num>: <strerror>, <op> '<path>'" — close enough, and the corpus can
 * only observe messages through the runtime C tests anyway (the supported
 * catch form is bindingless).
 */

static const char *scr_errno_name(int e, char *fallback, size_t cap) {
  switch (e) {
  case ENOENT: return "ENOENT";
  case EEXIST: return "EEXIST";
  case EACCES: return "EACCES";
  case EBUSY: return "EBUSY";
  case EINVAL: return "EINVAL";
  case EIO: return "EIO";
  case ENAMETOOLONG: return "ENAMETOOLONG";
  case ENOMEM: return "ENOMEM";
  case ENOSPC: return "ENOSPC";
  case ENOTDIR: return "ENOTDIR";
  case EISDIR: return "EISDIR";
  case ENOTEMPTY: return "ENOTEMPTY";
  case EPERM: return "EPERM";
  case EROFS: return "EROFS";
  case EXDEV: return "EXDEV";
  case EBADF: return "EBADF";
  case EAGAIN: return "EAGAIN";
  case EFBIG: return "EFBIG";
  case EPIPE: return "EPIPE";
  case ESPIPE: return "ESPIPE";
  default:
    snprintf(fallback, cap, "E%d", e);
    return fallback;
  }
}

static const char *scr_errno_text(int e) {
  switch (e) {
  case ENOENT: return "no such file or directory";
  case EEXIST: return "file already exists";
  case EACCES: return "permission denied";
  case EBUSY: return "resource busy or locked";
  case EINVAL: return "invalid argument";
  case EIO: return "i/o error";
  case ENAMETOOLONG: return "name too long";
  case ENOMEM: return "not enough memory";
  case ENOSPC: return "no space left on device";
  case ENOTDIR: return "not a directory";
  case EISDIR: return "illegal operation on a directory";
  case ENOTEMPTY: return "directory not empty";
  case EPERM: return "operation not permitted";
  case EROFS: return "read-only file system";
  case EXDEV: return "cross-device link not permitted";
  case EBADF: return "bad file descriptor";
  case EAGAIN: return "resource temporarily unavailable";
  case EFBIG: return "file too large";
  case EPIPE: return "broken pipe";
  case ESPIPE: return "invalid seek";
  default: return strerror(e);
  }
}

/* Node on WINDOWS reports fs error paths ABSOLUTIZED and backslashed
 * (its fs binding hands the Windows API namespaced absolute paths and the
 * error keeps that spelling): open("no.bin") fails with "... open
 * 'C:\cwd\no.bin'". _fullpath reproduces exactly that resolution. POSIX
 * Node reports the path as given — the passthrough arm. */
#ifdef _WIN32
static const char *scr_fs_err_path(const ScrStr *path, char buf[PATH_MAX]) {
  return _fullpath(buf, path->data, PATH_MAX) != NULL ? buf : path->data;
}
#else
static const char *scr_fs_err_path(const ScrStr *path, char buf[PATH_MAX]) {
  (void)buf;
  return path->data;
}
#endif

/* Exported (scr_runtime.h): scr_bytes.c's fs Buffer forms share it. */
void scr_fs_throw(int e, const char *op, const ScrStr *path) {
#ifdef _WIN32
  /* The CRT lands ERROR_ACCESS_DENIED in errno as EACCES; libuv's
   * uv_translate_sys_error maps the same Win32 error to EPERM, so that
   * is the code Node throws (a read-only file's write open, chmod on a
   * held file). Translate at the throw seam so every fs op agrees with
   * the Windows oracle. */
  if (e == EACCES) e = EPERM;
#endif
  char namebuf[16];
  const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
  const char *text = scr_errno_text(e);
  char pathbuf[PATH_MAX];
  const char *shown = scr_fs_err_path(path, pathbuf);
  size_t cap = strlen(name) + strlen(text) + strlen(op) + strlen(shown) + 8;
  char *msg = malloc(cap);
  if (!msg) {
    scr_trap("scriptc: out of memory\n");
  }
  int len = snprintf(msg, cap, "%s: %s, %s '%s'", name, text, op, shown);
  /* A real Error instance (name "Error", message = Node's text) — what a
   * typed catch's `e instanceof Error` + `e.message` observes in Node —
   * with `code` stamped to the errno name (the exotic-errno fallback
   * stamps its "E<num>" spelling; Node would carry the uv name there).
   * errno/syscall/path stay unrepresented (SEMANTICS.md divergence 13). */
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
  free(msg);
}

/* ── fs operations ───────────────────────────────────────────────────── */

ScrStr *scr_fs_read_file(ScrStr *path) {
  FILE *f = fopen(path->data, "rb");
  if (!f) {
    scr_fs_throw(errno, "open", path);
    return NULL;
  }
  size_t cap = 4096, len = 0;
  char *buf = malloc(cap);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  for (;;) {
    if (cap - len < 2048) {
      cap *= 2;
      char *grown = realloc(buf, cap);
      if (!grown) {
        scr_trap("scriptc: out of memory\n");
      }
      buf = grown;
    }
    size_t n = fread(buf + len, 1, cap - len, f);
    len += n;
    if (n == 0) break;
  }
  if (ferror(f)) {
    int e = errno;
    fclose(f);
    free(buf);
    scr_fs_throw(e, "read", path);
    return NULL;
  }
  fclose(f);
  ScrStr *s = scr_str_new(buf, len);
  free(buf);
  return s;
}

ScrStr *scr_fs_realpath(ScrStr *path) {
#ifdef __wasi__
  /* wasi-libc cannot canonicalize a path against a host filesystem root. */
  scr_fs_throw(ENOSYS, "realpath", path);
  return NULL;
#elif defined(_WIN32)
  /* _fullpath resolves . / .. and drive-relative forms (symlink-free —
   * the honest Windows approximation); a missing path throws Node's
   * lstat-spelled ENOENT like the POSIX arm. */
  char buf[PATH_MAX];
  if (_fullpath(buf, path->data, sizeof buf) == NULL) {
    scr_fs_throw(errno ? errno : ENOENT, "lstat", path);
    return NULL;
  }
  if (GetFileAttributesA(buf) == INVALID_FILE_ATTRIBUTES) {
    scr_fs_throw(ENOENT, "lstat", path);
    return NULL;
  }
  return scr_str_new(buf, strlen(buf));
#else
  /* realpath(3); Node's realpathSync reports failures with the "lstat"
   * syscall in the message ("ENOENT: no such file or directory, lstat
   * 'x'") — its own resolution walks lstat by component. */
  char buf[PATH_MAX];
  if (realpath(path->data, buf) == NULL) {
    scr_fs_throw(errno, "lstat", path);
    return NULL;
  }
  return scr_str_new(buf, strlen(buf));
#endif
}

static void scr_fs_write_common(ScrStr *path, ScrStr *data, const char *mode) {
  FILE *f = fopen(path->data, mode);
  if (!f) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  if (data->len > 0 && fwrite(data->data, 1, data->len, f) != data->len) {
    int e = errno;
    fclose(f);
    scr_fs_throw(e, "write", path);
    return;
  }
  if (fclose(f) != 0) scr_fs_throw(errno, "close", path);
}

void scr_fs_write_file(ScrStr *path, ScrStr *data) {
  scr_fs_write_common(path, data, "wb");
}

/* writeFileSync(p, data, { mode }): the mode is open(2)'s O_CREAT
 * argument — it applies at CREATION only (umask applying), and an
 * existing file keeps its permissions, exactly Node (which never chmods
 * here). Same error shapes as the plain form. */
static void scr_fs_write_file_open_mode(ScrStr *path, ScrStr *data,
                                        double mode, int disposition) {
  char recv[48], msg[176];
  scr_num_received(mode, recv);
  if (!(isfinite(mode) && trunc(mode) == mode)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"mode\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  if (mode < 0 || mode > 4294967295.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"mode\" is out of range. It must be >= 0 && <= 4294967295. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  /* O_BINARY: zero on POSIX; on Windows it keeps the CRT from translating
   * \n in these byte-exact writes (fopen's "wb" path already does). */
  int fd = open(path->data, O_WRONLY | O_CREAT | disposition | O_BINARY, (mode_t)mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  size_t at = 0;
  while (at < data->len) {
    ssize_t wrote = write(fd, data->data + at, data->len - at);
    if (wrote < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      close(fd);
      scr_fs_throw(e, "write", path);
      return;
    }
    at += (size_t)wrote;
  }
  if (close(fd) != 0) scr_fs_throw(errno, "close", path);
}

void scr_fs_write_file_mode(ScrStr *path, ScrStr *data, double mode) {
  scr_fs_write_file_open_mode(path, data, mode, O_TRUNC);
}

void scr_fs_write_file_exclusive_mode(ScrStr *path, ScrStr *data, double mode) {
  scr_fs_write_file_open_mode(path, data, mode, O_EXCL);
}

void scr_fs_append_file_mode(ScrStr *path, ScrStr *data, double mode, bool exclusive) {
  scr_fs_write_file_open_mode(path, data, mode, O_APPEND | (exclusive ? O_EXCL : 0));
}

void scr_fs_append_file(ScrStr *path, ScrStr *data) {
  scr_fs_write_common(path, data, "ab");
}

bool scr_fs_exists(ScrStr *path) {
  /* Like Node's existsSync: any failure (missing, EACCES on a parent, ...)
   * is simply false — never a throw. */
  return access(path->data, F_OK) == 0;
}

void scr_fs_mkdir(ScrStr *path) {
  if (scr_sys_mkdir(path->data, 0777) != 0) scr_fs_throw(errno, "mkdir", path);
}

/* mkdirSync(p, { mode }) non-recursive: mkdir(2) with the explicit mode
 * (umask applies, exactly as in Node — mode is the syscall argument;
 * Windows has no directory modes and drops it, like Node there). */
void scr_fs_mkdir_mode(ScrStr *path, double mode) {
  if (scr_sys_mkdir(path->data, (mode_t)mode) != 0) scr_fs_throw(errno, "mkdir", path);
}

void scr_fs_unlink(ScrStr *path) {
  if (unlink(path->data) != 0) scr_fs_throw(errno, "unlink", path);
}

void scr_fs_chmod(ScrStr *path, double mode) {
#ifdef __wasi__
  (void)mode;
  scr_fs_throw(ENOSYS, "chmod", path);
#else
  if (chmod(path->data, (mode_t)mode) != 0) scr_fs_throw(errno, "chmod", path);
#endif
}

void scr_fs_chown(ScrStr *path, double uid, double gid) {
#if defined(_WIN32) || defined(__wasi__)
  /* libuv's uv_fs_chown on Windows is an unconditional no-op success —
   * Node's chownSync "works" and changes nothing there; WASI likewise has
   * no ownership model. */
  (void)path; (void)uid; (void)gid;
#else
  /* Node passes the ids straight to chown(2); -1 is the POSIX "leave
   * unchanged" value and rides the same int cast. */
  if (chown(path->data, (uid_t)(int64_t)uid, (gid_t)(int64_t)gid) != 0) {
    scr_fs_throw(errno, "chown", path);
  }
#endif
}

/* fs.openSync(path, flags) → the raw fd (as f64) — the pair behind
 * spawn's fd-stdio form (openSync → stdio: ["ignore", fd, fd] →
 * closeSync). flags is Node's string grammar; an unknown flag throws
 * Node's ERR_INVALID_ARG_VALUE TypeError text, an open(2) failure the
 * usual Node-shaped fs error. Mode is Node's 0666 default (the numeric
 * third argument is a compile fence). */
double scr_fs_open(ScrStr *path, ScrStr *flags) {
  const char *f = flags->data;
  int of;
  if (strcmp(f, "r") == 0) of = O_RDONLY;
  else if (strcmp(f, "rs") == 0 || strcmp(f, "sr") == 0) of = O_RDONLY | O_SYNC;
  else if (strcmp(f, "r+") == 0) of = O_RDWR;
  else if (strcmp(f, "rs+") == 0 || strcmp(f, "sr+") == 0) of = O_RDWR | O_SYNC;
  else if (strcmp(f, "w") == 0) of = O_TRUNC | O_CREAT | O_WRONLY;
  else if (strcmp(f, "wx") == 0 || strcmp(f, "xw") == 0) of = O_TRUNC | O_CREAT | O_WRONLY | O_EXCL;
  else if (strcmp(f, "w+") == 0) of = O_TRUNC | O_CREAT | O_RDWR;
  else if (strcmp(f, "wx+") == 0 || strcmp(f, "xw+") == 0) of = O_TRUNC | O_CREAT | O_RDWR | O_EXCL;
  else if (strcmp(f, "a") == 0) of = O_APPEND | O_CREAT | O_WRONLY;
  else if (strcmp(f, "ax") == 0 || strcmp(f, "xa") == 0) of = O_APPEND | O_CREAT | O_WRONLY | O_EXCL;
  else if (strcmp(f, "as") == 0 || strcmp(f, "sa") == 0) of = O_APPEND | O_CREAT | O_WRONLY | O_SYNC;
  else if (strcmp(f, "a+") == 0) of = O_APPEND | O_CREAT | O_RDWR;
  else if (strcmp(f, "ax+") == 0 || strcmp(f, "xa+") == 0) of = O_APPEND | O_CREAT | O_RDWR | O_EXCL;
  else if (strcmp(f, "as+") == 0 || strcmp(f, "sa+") == 0) of = O_APPEND | O_CREAT | O_RDWR | O_SYNC;
  else {
    char msg[128];
    int len = snprintf(msg, sizeof msg, "The argument 'flags' is invalid. Received '%s'", f);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
    return 0;
  }
  int fd = open(path->data, of | O_BINARY, 0666);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return 0;
  }
  return (double)fd;
}

/* fs.closeSync(fd) — close(2); failure throws Node's path-less fs error
 * shape ("EBADF: bad file descriptor, close"). */

/* Offset-preserving read for fs.readSync's numeric-position form. POSIX
 * supplies pread(2). Windows follows libuv's synchronous-handle recipe:
 * ReadFile with an OVERLAPPED byte offset, then restore the handle position
 * because synchronous ReadFile updates it even when OVERLAPPED is present. */
static ssize_t scr_fs_pread(int fd, void *data, size_t length, double position) {
#ifdef _WIN32
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    errno = EBADF;
    return -1;
  }

  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof overlapped);
  LARGE_INTEGER at;
  at.QuadPart = (LONGLONG)position;
  overlapped.Offset = at.LowPart;
  overlapped.OffsetHigh = at.HighPart;

  LARGE_INTEGER zero;
  LARGE_INTEGER original;
  zero.QuadPart = 0;
  BOOL restore = SetFilePointerEx(handle, zero, &original, FILE_CURRENT);
  DWORD got = 0;
  DWORD want = length > (size_t)UINT32_MAX ? UINT32_MAX : (DWORD)length;
  BOOL ok = ReadFile(handle, data, want, &got, &overlapped);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  if (restore) (void)SetFilePointerEx(handle, original, NULL, FILE_BEGIN);
  /* ReadFile may report a terminal status after still filling part of the
   * caller's buffer (notably ERROR_MORE_DATA for a message-mode pipe).
   * libuv/Node return those bytes and surface the status on the next read. */
  if (ok || got > 0 || error == ERROR_HANDLE_EOF || error == ERROR_BROKEN_PIPE) {
    return (ssize_t)got;
  }

  /* The read-specific subset of libuv's Win32-to-errno translation. */
  switch (error) {
    case ERROR_INVALID_HANDLE:
    case ERROR_ACCESS_DENIED:
      errno = EBADF;
      break;
    case ERROR_INVALID_FUNCTION:
    case ERROR_INVALID_PARAMETER:
      errno = EINVAL;
      break;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
      errno = ENOMEM;
      break;
    case ERROR_OPERATION_ABORTED:
      errno = EINTR;
      break;
    default:
      errno = EIO;
      break;
  }
  return -1;
#else
  return pread(fd, data, length, (off_t)position);
#endif
}

/* Offset-preserving write for fs.writeSync's numeric-position forms. The
 * Windows arm mirrors scr_fs_pread: WriteFile receives an OVERLAPPED offset
 * and the CRT descriptor's current position is restored before returning. */
static ssize_t scr_fs_pwrite(int fd, const void *data, size_t length, double position) {
#ifdef _WIN32
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    errno = EBADF;
    return -1;
  }

  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof overlapped);
  LARGE_INTEGER at;
  at.QuadPart = (LONGLONG)position;
  overlapped.Offset = at.LowPart;
  overlapped.OffsetHigh = at.HighPart;

  LARGE_INTEGER zero;
  LARGE_INTEGER original;
  zero.QuadPart = 0;
  BOOL restore = SetFilePointerEx(handle, zero, &original, FILE_CURRENT);
  DWORD wrote = 0;
  DWORD want = length > (size_t)UINT32_MAX ? UINT32_MAX : (DWORD)length;
  BOOL ok = WriteFile(handle, data, want, &wrote, &overlapped);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  if (restore) (void)SetFilePointerEx(handle, original, NULL, FILE_BEGIN);
  if (ok || wrote > 0) return (ssize_t)wrote;

  switch (error) {
    case ERROR_INVALID_HANDLE:
    case ERROR_ACCESS_DENIED:
      errno = EBADF;
      break;
    case ERROR_INVALID_FUNCTION:
    case ERROR_INVALID_PARAMETER:
      errno = EINVAL;
      break;
    case ERROR_DISK_FULL:
    case ERROR_HANDLE_DISK_FULL:
      errno = ENOSPC;
      break;
    case ERROR_FILE_TOO_LARGE:
      errno = EFBIG;
      break;
    case ERROR_BROKEN_PIPE:
    case ERROR_NO_DATA:
      errno = EPIPE;
      break;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
      errno = ENOMEM;
      break;
    case ERROR_OPERATION_ABORTED:
      errno = EINTR;
      break;
    default:
      errno = EIO;
      break;
  }
  return -1;
#else
  return pwrite(fd, data, length, (off_t)position);
#endif
}

static bool scr_fs_write_fd_valid(double fd) {
  char msg[160];
  char recv[48];
  scr_num_received(fd, recv);
  if (!(isfinite(fd) && trunc(fd) == fd)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"fd\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (fd < 0 || fd > 2147483647.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"fd\" is out of range. It must be >= 0 && <= 2147483647. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

/* write(2) raises SIGPIPE before returning EPIPE when a pipe/socket peer has
 * closed; write(2)/pwrite(2) likewise raise SIGXFSZ before returning EFBIG at
 * RLIMIT_FSIZE. Node turns both into catchable fs errors. Do the same per
 * calling thread rather than changing process dispositions (which spawned
 * children would inherit). Consume only a signal freshly generated by this
 * call, preserving any signal that was already pending. */
static ssize_t scr_fs_write_once(int fd, const void *data, size_t length,
                                 bool positioned, double position) {
#if defined(_WIN32) || defined(__wasi__)
  return positioned
    ? scr_fs_pwrite(fd, data, length, position)
    : write(fd, data, length);
#else
  sigset_t write_set, old_set, pending;
  sigemptyset(&write_set);
#ifdef SIGPIPE
  sigaddset(&write_set, SIGPIPE);
#endif
#ifdef SIGXFSZ
  sigaddset(&write_set, SIGXFSZ);
#endif
  if (pthread_sigmask(SIG_BLOCK, &write_set, &old_set) != 0) {
    return positioned
      ? scr_fs_pwrite(fd, data, length, position)
      : write(fd, data, length);
  }

  bool pending_known = sigpending(&pending) == 0;
#ifdef SIGPIPE
  bool had_pipe = pending_known && sigismember(&pending, SIGPIPE) == 1;
#endif
#ifdef SIGXFSZ
  bool had_xfsz = pending_known && sigismember(&pending, SIGXFSZ) == 1;
#endif
  ssize_t n = positioned
    ? scr_fs_pwrite(fd, data, length, position)
    : write(fd, data, length);
  int write_errno = errno;

  int generated = 0;
  if (n < 0 && pending_known && sigpending(&pending) == 0) {
#ifdef SIGPIPE
    if (write_errno == EPIPE && !had_pipe && sigismember(&pending, SIGPIPE) == 1) {
      generated = SIGPIPE;
    }
#endif
#ifdef SIGXFSZ
    if (write_errno == EFBIG && !had_xfsz && sigismember(&pending, SIGXFSZ) == 1) {
      generated = SIGXFSZ;
    }
#endif
  }
  if (generated != 0) {
    sigset_t generated_set;
    sigemptyset(&generated_set);
    sigaddset(&generated_set, generated);
    int caught = 0;
    int wait_err;
    do {
      wait_err = sigwait(&generated_set, &caught);
    } while (wait_err == EINTR);
  }

  (void)pthread_sigmask(SIG_SETMASK, &old_set, NULL);
  errno = write_errno;
  return n;
#endif
}

static double scr_fs_write_bytes(double fd, const void *data, size_t length,
                                 double position) {
  if (!scr_fs_write_fd_valid(fd)) return 0;
  /* Node/libuv treats every position other than a safe nonnegative integer
   * as the current-offset sentinel for writes (unlike readSync, it does not
   * throw for negative/fractional positions). */
  bool positioned = isfinite(position) && trunc(position) == position &&
                    position >= 0 && position <= 9007199254740991.0;
  ssize_t n;
  do {
    n = scr_fs_write_once((int)fd, data, length, positioned, position);
  } while (n < 0 && errno == EINTR);
  if (n < 0) {
    int e = errno;
    char namebuf[16];
    const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
    const char *text = scr_errno_text(e);
    char msg[160];
    int len = snprintf(msg, sizeof msg, "%s: %s, write", name, text);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
    return 0;
  }
  return (double)n;
}

/* fs.writeSync(fd, buffer, offset, length[, position]) — validates the
 * caller window before touching the descriptor, then submits one write like
 * Node/libuv. Positioned writes do not advance the descriptor. */
double scr_fs_write_sync(double fd, ScrBytes *buf, double offset, double length,
                         double position) {
  size_t bytelen = buf->len; /* frontend admits u8 buffers only */
  char msg[160];
  char recv[48];
  scr_num_received(offset, recv);
  if (!(isfinite(offset) && trunc(offset) == offset)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"offset\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (offset < 0 || offset > 9007199254740991.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (offset > (double)bytelen) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"offset\" is out of range. It must be <= %zu. Received %s",
                       bytelen, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }

  scr_num_received(length, recv);
  if (length < 0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"length\" is out of range. It must be >= 0. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  size_t off = (size_t)offset;
  if (length > (double)(bytelen - off)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"length\" is out of range. It must be <= %zu. Received %s",
                       bytelen - off, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (!(isfinite(length) && trunc(length) == length)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"length\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  return scr_fs_write_bytes(fd, buf->data + off, (size_t)length, position);
}

double scr_fs_write_str_sync(double fd, ScrStr *data, double position,
                             ScrStr *encoding) {
  (void)encoding; /* frontend proves utf8; the argument still evaluates */
  return scr_fs_write_bytes(fd, data->data, data->len, position);
}

/* fs.readSync(fd, buffer, offset, length[, position]) — the buffer form.
 * Node validates offset/length against the buffer before reading and
 * throws ERR_OUT_OF_RANGE; here the checks clamp to the same contract and
 * throw the RangeError shape. Position -1 means the fd's current offset;
 * nonnegative positions do not advance it. Returns the byte count the OS
 * reports; errors carry the errno name like the other fd operations. */
double scr_fs_read_sync(double fd, ScrBytes *buf, double offset, double length,
                        double position) {
  size_t bytelen = buf->len; /* u8 buffers: elem count == byte count */
  char msg[160];
  int mlen;
  /* Node's exact texts: offset validates against MAX_SAFE_INTEGER's range
   * form, length against the remaining window (validateOffset vs the
   * buffer-bounds check in fs.readSync). */
  char numbuf[40];
  if (!(isfinite(offset) && trunc(offset) == offset)) {
    char recv[48];
    scr_num_received(offset, recv);
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"offset\" is out of range. It must be an integer. Received %s",
                    recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (offset < 0 || offset > 9007199254740991.0) {
    numbuf[scr_f64_to_str(offset, numbuf)] = 0;
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s",
                    numbuf);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  /* Node returns after offset's intrinsic validation when the requested
   * length normalizes to zero: buffer-window bounds, position, and fd are
   * not consulted. Preserve the existing size_t coercion's [0, 1) case. */
  if (length >= 0 && length < 1) return 0;
  if (offset > (double)bytelen) {
    numbuf[scr_f64_to_str(offset, numbuf)] = 0;
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s",
                    numbuf);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  size_t off = (size_t)offset;
  if (length < 0 || (double)length > (double)(bytelen - off)) {
    numbuf[scr_f64_to_str(length, numbuf)] = 0;
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"length\" is out of range. It must be <= %zu. Received %s",
                    bytelen - off, numbuf);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  size_t want = (size_t)length;
  if (!(isfinite(position) && trunc(position) == position)) {
    char recv[48];
    scr_num_received(position, recv);
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"position\" is out of range. It must be an integer. Received %s",
                    recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (position < -1 || position > 9007199254740991.0) {
    char recv[48];
    scr_num_received(position, recv);
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"position\" is out of range. It must be >= -1 && <= 9007199254740991. Received %s",
                    recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  ssize_t n = position == -1
    ? read((int)fd, buf->data + off, want)
    : scr_fs_pread((int)fd, buf->data + off, want, position);
  if (n < 0) {
    int e = errno;
    char namebuf[16];
    const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
    const char *text = scr_errno_text(e);
    char msg[160];
    int len = snprintf(msg, sizeof msg, "%s: %s, read", name, text);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
    return 0;
  }
  return (double)n;
}

void scr_fs_close(double fd) {
  if (close((int)fd) != 0) {
    int e = errno;
    char namebuf[16];
    const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
    const char *text = scr_errno_text(e);
    char msg[160];
    int len = snprintf(msg, sizeof msg, "%s: %s, close", name, text);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
  }
}

/* The two-path fs error shape — Node's copyfile errors quote both ends:
 * "ENOENT: no such file or directory, copyfile 'src' -> 'dest'". */
static void scr_fs_throw2(int e, const char *op, const ScrStr *src, const ScrStr *dest) {
  char namebuf[16];
  const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
  const char *text = scr_errno_text(e);
  char srcbuf[PATH_MAX], destbuf[PATH_MAX];
  const char *shown_src = scr_fs_err_path(src, srcbuf);
  const char *shown_dest = scr_fs_err_path(dest, destbuf);
  size_t cap = strlen(name) + strlen(text) + strlen(op) + strlen(shown_src) + strlen(shown_dest) + 16;
  char *msg = malloc(cap);
  if (!msg) {
    scr_trap("scriptc: out of memory\n");
  }
  int len = snprintf(msg, cap, "%s: %s, %s '%s' -> '%s'", name, text, op, shown_src, shown_dest);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
  free(msg);
}

/* copyFileSync(src, dest): contents copied into a created-or-truncated
 * destination carrying the SOURCE's permission bits — libuv's
 * uv_fs_copyfile behavior behind Node's copyFileSync (umask applies at
 * creation, like any open(2)). Every failure throws catchably with the
 * two-path message and the syscall name Node reports ("copyfile"). */
void scr_fs_copyfile(ScrStr *src, ScrStr *dest) {
  int in = open(src->data, O_RDONLY | O_BINARY);
  if (in < 0) {
    scr_fs_throw2(errno, "copyfile", src, dest);
    return;
  }
  struct stat st;
  if (fstat(in, &st) != 0) {
    int e = errno;
    close(in);
    scr_fs_throw2(e, "copyfile", src, dest);
    return;
  }
  int out = open(dest->data, O_WRONLY | O_CREAT | O_TRUNC | O_BINARY, st.st_mode & 07777);
  if (out < 0) {
    int e = errno;
    close(in);
    scr_fs_throw2(e, "copyfile", src, dest);
    return;
  }
  char buf[65536];
  for (;;) {
    ssize_t got = read(in, buf, sizeof buf);
    if (got < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      close(in);
      close(out);
      scr_fs_throw2(e, "copyfile", src, dest);
      return;
    }
    if (got == 0) break;
    ssize_t at = 0;
    while (at < got) {
      ssize_t wrote = write(out, buf + at, (size_t)(got - at));
      if (wrote < 0) {
        if (errno == EINTR) continue;
        int e = errno;
        close(in);
        close(out);
        scr_fs_throw2(e, "copyfile", src, dest);
        return;
      }
      at += wrote;
    }
  }
  close(in);
  if (close(out) != 0) scr_fs_throw2(errno, "copyfile", src, dest);
}

/* renameSync(old, new): rename(2), Node's two-path error shape ("ENOENT:
 * no such file or directory, rename 'a' -> 'b'"). Windows must bypass
 * the CRT's rename(): it refuses an existing destination and cannot move
 * directories between parents, while Node/libuv uses MoveFileExW with
 * MOVEFILE_REPLACE_EXISTING. Runtime strings are UTF-8, so feed the wide
 * Win32 API rather than the active-code-page `A` form. */
#ifdef _WIN32
static WCHAR *scr_fs_win_wide(const ScrStr *path) {
  if (path->len > INT_MAX) {
    SetLastError(ERROR_FILENAME_EXCED_RANGE);
    return NULL;
  }
  int n = path->len > 0
    ? MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                          path->data, (int)path->len, NULL, 0)
    : 0;
  if (path->len > 0 && n == 0) return NULL;
  WCHAR *wide = malloc(((size_t)n + 1) * sizeof *wide);
  if (!wide) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  if (n > 0) {
    (void)MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                              path->data, (int)path->len, wide, n);
  }
  wide[n] = L'\0';
  return wide;
}

/* The reachable fs subset of libuv's uv_translate_sys_error table. */
static int scr_fs_win_errno(DWORD error) {
  switch (error) {
  case ERROR_ALREADY_EXISTS:
  case ERROR_FILE_EXISTS:
    return EEXIST;
  case ERROR_LOCK_VIOLATION:
  case ERROR_PIPE_BUSY:
  case ERROR_SHARING_VIOLATION:
    return EBUSY;
  case ERROR_INVALID_FUNCTION:
    return EISDIR;
  case ERROR_INSUFFICIENT_BUFFER:
  case ERROR_INVALID_DATA:
  case ERROR_INVALID_PARAMETER:
    return EINVAL;
  case ERROR_BUFFER_OVERFLOW:
  case ERROR_FILENAME_EXCED_RANGE:
    return ENAMETOOLONG;
  case ERROR_NOT_ENOUGH_MEMORY:
  case ERROR_OUTOFMEMORY:
    return ENOMEM;
  case ERROR_CANNOT_MAKE:
  case ERROR_DISK_FULL:
  case ERROR_HANDLE_DISK_FULL:
    return ENOSPC;
  case ERROR_DIR_NOT_EMPTY:
    return ENOTEMPTY;
  case ERROR_ACCESS_DENIED:
  case ERROR_PRIVILEGE_NOT_HELD:
    return EPERM;
  case ERROR_WRITE_PROTECT:
    return EROFS;
  case ERROR_NOT_SAME_DEVICE:
    return EXDEV;
  case ERROR_BAD_PATHNAME:
  case ERROR_DIRECTORY:
  case ERROR_FILE_NOT_FOUND:
  case ERROR_INVALID_DRIVE:
  case ERROR_INVALID_NAME:
  case ERROR_PATH_NOT_FOUND:
    return ENOENT;
  default:
    return EIO;
  }
}
#endif

int scr_fs_rename_raw(const ScrStr *oldpath, const ScrStr *newpath) {
#ifdef _WIN32
  WCHAR *oldwide = scr_fs_win_wide(oldpath);
  if (!oldwide) return scr_fs_win_errno(GetLastError());
  WCHAR *newwide = scr_fs_win_wide(newpath);
  if (!newwide) {
    DWORD error = GetLastError();
    free(oldwide);
    return scr_fs_win_errno(error);
  }
  BOOL ok = MoveFileExW(oldwide, newwide, MOVEFILE_REPLACE_EXISTING);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  free(oldwide);
  free(newwide);
  return ok ? 0 : scr_fs_win_errno(error);
#else
  return rename(oldpath->data, newpath->data) == 0 ? 0 : errno;
#endif
}

void scr_fs_rename_error(int error, const ScrStr *oldpath, const ScrStr *newpath) {
  scr_fs_throw2(error, "rename", oldpath, newpath);
}

void scr_fs_rename(ScrStr *oldpath, ScrStr *newpath) {
  int error = scr_fs_rename_raw(oldpath, newpath);
  if (error != 0) scr_fs_rename_error(error, oldpath, newpath);
}

void scr_fs_rm(ScrStr *path) {
  /* Node's rmSync: lstat first (a missing path reports the lstat syscall),
   * refuse directories (Node requires `recursive`, which the scriptc
   * surface doesn't declare — the message wording diverges from Node's
   * ERR_FS_EISDIR, see SEMANTICS.md), then unlink. */
  struct stat st;
  if (lstat(path->data, &st) != 0) {
    scr_fs_throw(errno, "lstat", path);
    return;
  }
  if (S_ISDIR(st.st_mode)) {
    scr_fs_throw(EISDIR, "rm", path);
    return;
  }
  if (unlink(path->data) != 0) scr_fs_throw(errno, "unlink", path);
}

void scr_fs_rmdir(ScrStr *path) {
  if (rmdir(path->data) != 0) scr_fs_throw(errno, "rmdir", path);
}

/* ── fs option forms ─────────────────────────────────────────────────
 * mkdirSync(p, { recursive: true }), rmSync(p, { recursive, force }),
 * mkdtempSync(prefix), accessSync(p, mode), and the readFileSync(fd)
 * forms — the slice real CLIs use. All throw catchably like the rest of
 * sync fs, with Node's errno/path shapes (verified against Node). */

/* Node's recursive mkdir algorithm: try mkdir; EEXIST is fine iff the
 * path is a directory (a file target throws EEXIST at that path); ENOENT
 * creates the parent first and retries. ENOTDIR past a file reports the
 * FULL requested path, like Node. `path` is a NUL-terminated mutable
 * buffer of `len` bytes. */
/* The path separators the RECURSIVE walk recognizes: win32 targets take
 * both slashes (the path module hands out backslashed paths there);
 * POSIX '/' only — a backslash is an ordinary filename byte. */
static bool scr_fs_sep(char c) {
#ifdef _WIN32
  if (c == '\\') return true;
#endif
  return c == '/';
}

static void scr_mkdir_rec(char *path, size_t len, mode_t mode) {
  if (scr_sys_mkdir(path, mode) == 0) return;
  int e = errno;
  struct stat st;
  if (e == EEXIST) {
    if (stat(path, &st) == 0 && S_ISDIR(st.st_mode)) return;
  } else if (e == ENOENT) {
    /* Parent: trim trailing separators, the last component, then the
     * separator run before it (keep "/" itself). */
    size_t i = len;
    while (i > 0 && scr_fs_sep(path[i - 1])) i--;
    while (i > 0 && !scr_fs_sep(path[i - 1])) i--;
    while (i > 1 && scr_fs_sep(path[i - 1])) i--;
    if (i > 0 && i < len) {
      char saved = path[i];
      path[i] = 0;
#ifdef _WIN32
      /* POSIX mkdir answers ENOTDIR itself when a path component is a
       * FILE; the CRT answers ENOENT for that too. Node on Windows still
       * reports ENOTDIR with the full requested path — recover the
       * distinction from the parent's stat before recursing. */
      if (stat(path, &st) == 0 && !S_ISDIR(st.st_mode)) {
        path[i] = saved;
        ScrStr *full = scr_str_new(path, len);
        scr_fs_throw(ENOTDIR, "mkdir", full);
        scr_str_release(full);
        return;
      }
#endif
      scr_mkdir_rec(path, i, mode);
      path[i] = saved;
      if (scr_exc_pending()) return;
      if (scr_sys_mkdir(path, mode) == 0) return;
      e = errno;
      if (e == EEXIST && stat(path, &st) == 0 && S_ISDIR(st.st_mode)) return;
    }
  }
  ScrStr *p = scr_str_new(path, len);
  scr_fs_throw(e, "mkdir", p);
  scr_str_release(p);
}

void scr_fs_mkdir_recursive(ScrStr *path) {
  char *buf = malloc(path->len + 1);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  memcpy(buf, path->data, path->len + 1); /* ScrStr data is NUL-terminated */
  scr_mkdir_rec(buf, path->len, 0777);
  free(buf);
}

/* mkdirSync(p, { recursive: true, mode }): Node passes the mode to every
 * directory the walk creates (existing ones keep theirs). */
void scr_fs_mkdir_recursive_mode(ScrStr *path, double mode) {
  char *buf = malloc(path->len + 1);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  memcpy(buf, path->data, path->len + 1);
  scr_mkdir_rec(buf, path->len, (mode_t)mode);
  free(buf);
}

/* First failure of an rm walk, recorded instead of thrown so the retry
 * form can decide (retryable errno + attempts left → sleep and go again)
 * before anything reaches the exception cell. `path` is +1 when err != 0;
 * the throwers release it after scr_fs_throw. */
typedef struct {
  int err;
  const char *op;
  ScrStr *path;
} ScrRmFail;

static void scr_rm_fail_set(ScrRmFail *f, int err, const char *op, const char *path, size_t len) {
  if (f->err != 0) return; /* first failure wins, exactly like the old unwind */
  f->err = err;
  f->op = op;
  f->path = scr_str_new(path, len);
}

/* Post-order tree removal for rmSync's recursive form. Stops at (and
 * records) the first failure, with the failing path and syscall name. */
static void scr_rm_tree_e(const char *path, size_t len, ScrRmFail *f) {
  struct stat st;
  if (lstat(path, &st) != 0) {
    scr_rm_fail_set(f, errno, "lstat", path, len);
    return;
  }
  if (!S_ISDIR(st.st_mode)) {
    if (unlink(path) != 0) scr_rm_fail_set(f, errno, "unlink", path, len);
    return;
  }
  DIR *d = opendir(path);
  if (!d) {
    scr_rm_fail_set(f, errno, "scandir", path, len);
    return;
  }
  const struct dirent *ent;
  while ((ent = readdir(d)) != NULL) {
    if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
    size_t namelen = strlen(ent->d_name);
    char *child = malloc(len + 1 + namelen + 1);
    if (!child) {
      scr_trap("scriptc: out of memory\n");
    }
    memcpy(child, path, len);
    child[len] = '/';
    memcpy(child + len + 1, ent->d_name, namelen + 1);
    scr_rm_tree_e(child, len + 1 + namelen, f);
    free(child);
    if (f->err != 0) {
      closedir(d);
      return;
    }
  }
  closedir(d);
  if (rmdir(path) != 0) scr_rm_fail_set(f, errno, "rmdir", path, len);
}

/* One rm attempt (the shared core of both option forms): lstat dispatch,
 * force's ENOENT swallow, the non-recursive directory rejection, and the
 * tree walk — failures recorded in `f`, never thrown. */
static void scr_fs_rm_attempt(ScrStr *path, bool recursive, bool force, ScrRmFail *f) {
  struct stat st;
  if (lstat(path->data, &st) != 0) {
    if (force && errno == ENOENT) return; /* Node: force swallows ENOENT */
    scr_rm_fail_set(f, errno, "lstat", path->data, path->len);
    return;
  }
  if (S_ISDIR(st.st_mode)) {
    if (!recursive) {
      /* Node throws ERR_FS_EISDIR here; the EISDIR-prefixed wording is
       * divergence 13's documented difference. */
      scr_rm_fail_set(f, EISDIR, "rm", path->data, path->len);
      return;
    }
    scr_rm_tree_e(path->data, path->len, f);
    return;
  }
  if (unlink(path->data) != 0) scr_rm_fail_set(f, errno, "unlink", path->data, path->len);
}

void scr_fs_rm_opts(ScrStr *path, bool recursive, bool force) {
  ScrRmFail f = {0, NULL, NULL};
  scr_fs_rm_attempt(path, recursive, force, &f);
  if (f.err != 0) {
    scr_fs_throw(f.err, f.op, f.path);
    scr_str_release(f.path);
  }
}

/* rmSync(p, { recursive, force, maxRetries, retryDelay }): Node retries
 * the operation on EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM up to maxRetries
 * times, waiting retryDelay ms LONGER on each try (linear backoff — the
 * fs.rmSync documented semantics). Everything else throws immediately
 * with the failing path, exactly like the plain options form. */
void scr_fs_rm_opts_retry(ScrStr *path, bool recursive, bool force, double max_retries, double retry_delay) {
  long tries = max_retries > 0 ? (long)max_retries : 0;
  double delay_ms = retry_delay > 0 ? retry_delay : 0;
  ScrRmFail f = {0, NULL, NULL};
  for (long attempt = 0;; attempt++) {
    f.err = 0;
    f.op = NULL;
    if (f.path) {
      scr_str_release(f.path);
      f.path = NULL;
    }
    scr_fs_rm_attempt(path, recursive, force, &f);
    if (f.err == 0) return;
    bool retryable = f.err == EBUSY || f.err == EMFILE || f.err == ENFILE ||
                     f.err == ENOTEMPTY || f.err == EPERM;
    if (!retryable || attempt >= tries) break;
    double ms = delay_ms * (double)(attempt + 1);
    if (ms > 0) {
      struct timespec ts;
      ts.tv_sec = (time_t)(ms / 1000.0);
      ts.tv_nsec = (long)((ms - (double)ts.tv_sec * 1000.0) * 1000000.0);
      scr_nanosleep(&ts, NULL);
    }
  }
  scr_fs_throw(f.err, f.op, f.path);
  scr_str_release(f.path);
}

#if defined(_WIN32) || defined(__wasi__)
/* No mkdtemp in the Windows CRT or WASI libc: libuv's own fallback shape — six random
 * [a-z0-9] name characters from the CSPRNG, retried on EEXIST. */
static char *scr_portable_mkdtemp(char *tmpl) {
  static const char cs[] = "abcdefghijklmnopqrstuvwxyz0123456789";
  size_t len = strlen(tmpl);
  for (int tries = 0; tries < 32; tries++) {
    unsigned char r[6];
    arc4random_buf(r, sizeof r);
    for (size_t i = 0; i < 6; i++) tmpl[len - 6 + i] = cs[r[i] % 36];
    if (scr_sys_mkdir(tmpl, 0777) == 0) return tmpl;
    if (errno != EEXIST) break;
  }
  memcpy(tmpl + len - 6, "XXXXXX", 6); /* the error message shows the template */
  return NULL;
}
#define mkdtemp scr_portable_mkdtemp
#endif

ScrStr *scr_fs_mkdtemp(ScrStr *prefix) {
  char *tmpl = malloc(prefix->len + 7);
  if (!tmpl) {
    scr_trap("scriptc: out of memory\n");
  }
  memcpy(tmpl, prefix->data, prefix->len);
  memcpy(tmpl + prefix->len, "XXXXXX", 7);
  if (!mkdtemp(tmpl)) {
    /* Node reports the template, X's included: mkdtemp '/nope/x-XXXXXX' */
    int e = errno;
    ScrStr *shown = scr_str_new(tmpl, prefix->len + 6);
    scr_fs_throw(e, "mkdtemp", shown);
    scr_str_release(shown);
    free(tmpl);
    return NULL;
  }
  ScrStr *out = scr_str_new(tmpl, prefix->len + 6);
  free(tmpl);
  return out;
}

void scr_fs_access(ScrStr *path, double mode) {
  int m = (int)mode;
#ifdef _WIN32
  /* The CRT access() rejects X_OK (there is no execute bit); Node on
   * Windows treats X_OK as F_OK, so mask it down to the R/W bits. */
  m &= 6;
#endif
  if (access(path->data, m) != 0) scr_fs_throw(errno, "access", path);
}

/* The no-path variant of the fs error shape — Node's fd reads report
 * "EBADF: bad file descriptor, read" with no quoted path. */
static void scr_fs_throw_nopath(int e, const char *op) {
  char namebuf[16];
  const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
  const char *text = scr_errno_text(e);
  char msg[256];
  int len = snprintf(msg, sizeof msg, "%s: %s, %s", name, text, op);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
}

/* read(2) loop to EOF from the CURRENT position — Node's
 * readFileSync(fd) semantics for pipes and files alike (the stdin
 * pattern: readFileSync(0, "utf8")). Returns the malloc'd buffer and
 * its length, or NULL with the exception pending. */
static char *scr_read_fd_all(double fd, size_t *out_len) {
  size_t cap = 4096, len = 0;
  char *buf = malloc(cap);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  for (;;) {
    if (cap - len < 2048) {
      cap *= 2;
      char *grown = realloc(buf, cap);
      if (!grown) {
        scr_trap("scriptc: out of memory\n");
      }
      buf = grown;
    }
    ssize_t n = read((int)fd, buf + len, cap - len);
    if (n < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      free(buf);
      scr_fs_throw_nopath(e, "read");
      return NULL;
    }
    if (n == 0) break;
    len += (size_t)n;
  }
  *out_len = len;
  return buf;
}

ScrStr *scr_fs_read_fd(double fd) {
  size_t len;
  char *buf = scr_read_fd_all(fd, &len);
  if (!buf) return NULL;
  ScrStr *s = scr_str_new(buf, len);
  free(buf);
  return s;
}

ScrBytes *scr_fs_read_fd_bytes(double fd) {
  size_t len;
  char *buf = scr_read_fd_all(fd, &len);
  if (!buf) return NULL;
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (len > 0) memcpy(b->data, buf, len);
  free(buf);
  return b;
}

/* ── Atomics.wait: the synchronous-sleep idiom ───────────────────────
 * Atomics.wait(int32Array, idx, expected, timeoutMs). scriptc has no
 * threads: nothing can ever notify a waiter, so the spec's behavior for
 * every compilable program is exactly "compare, then sleep out the
 * timeout" — "not-equal" immediately when the element differs from
 * `expected`, "timed-out" after a real nanosleep otherwise ("ok" is
 * unreachable; the compiler requires the timeout argument, since an
 * infinite wait here would be a certain deadlock). The sleep resumes
 * across EINTR so signals don't shorten it. Timeout semantics follow the
 * spec: NaN/+Infinity would be infinite (compiler-fenced by requiring
 * the argument, but a runtime NaN clamps to 0 defensively), negatives
 * clamp to 0. */
ScrStr *scr_atomics_wait(ScrBytes *arr, double idx, double expected, double timeout_ms) {
  double have = scr_bytes_get(arr, idx); /* traps out-of-range like every access */
  /* The comparison is on the stored int32 vs ToInt32(expected). */
  double t = expected;
  if (t != t || isinf(t)) t = 0;
  else {
    t = trunc(t);
    t = fmod(t, 4294967296.0);
    if (t < 0) t += 4294967296.0;
    if (t >= 2147483648.0) t -= 4294967296.0;
  }
  if (have != t) return scr_str_new("not-equal", 9);
  double ms = timeout_ms;
  if (ms != ms || ms < 0) ms = 0;
  if (ms > 0) {
    struct timespec left = {
        (time_t)(ms / 1000.0),
        (long)((ms - (double)(time_t)(ms / 1000.0) * 1000.0) * 1e6),
    };
    struct timespec rem;
    while (scr_nanosleep(&left, &rem) != 0 && errno == EINTR) left = rem;
  }
  return scr_str_new("timed-out", 9);
}

/* ── the tty probes ──────────────────────────────────────────────────── */

bool scr_process_is_tty(double fd) { return isatty((int)fd) != 0; }

/* Terminal geometry for process.stdout/stderr.columns/rows: ioctl(TIOCGWINSZ) on
 * the stream's fd, exactly Node's tty.WriteStream source of truth. A
 * non-TTY stream, or a terminal that refuses the ioctl, answers -1 and
 * the emitter's union construction turns that into the undefined arm —
 * Node's missing geometry on non-TTY streams. */
static double scr_process_dimension(double fd, bool rows) {
  if (!isatty((int)fd)) return -1;
#ifdef _WIN32
  /* The console buffer's visible window — libuv's uv_tty_get_winsize. */
  HANDLE h = (HANDLE)_get_osfhandle((int)fd);
  CONSOLE_SCREEN_BUFFER_INFO info;
  if (h == INVALID_HANDLE_VALUE || !GetConsoleScreenBufferInfo(h, &info)) return -1;
  return rows ? (double)(info.srWindow.Bottom - info.srWindow.Top + 1)
              : (double)(info.srWindow.Right - info.srWindow.Left + 1);
#elif defined(__wasi__)
  (void)rows;
  return -1;
#else
  struct winsize ws;
  if (ioctl((int)fd, TIOCGWINSZ, &ws) != 0) return -1;
  return rows ? (double)ws.ws_row : (double)ws.ws_col;
#endif
}

double scr_process_columns(double fd) { return scr_process_dimension(fd, false); }
double scr_process_rows(double fd) { return scr_process_dimension(fd, true); }
