"""Run one differential executable in a bounded, kill-on-close Windows job."""
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import subprocess
from shutil import which
import sys
import time


class BasicLimits(c.Structure):
    _fields_ = [("process_time", c.c_longlong), ("job_time", c.c_longlong),
                ("flags", w.DWORD), ("min_working_set", c.c_size_t),
                ("max_working_set", c.c_size_t), ("active_limit", w.DWORD),
                ("affinity", c.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]


class IoCounters(c.Structure):
    _fields_ = [(name, c.c_ulonglong) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]


class ExtendedLimits(c.Structure):
    _fields_ = [("basic", BasicLimits), ("io", IoCounters),
                ("process_memory", c.c_size_t), ("job_memory", c.c_size_t),
                ("peak_process_memory", c.c_size_t), ("peak_job_memory", c.c_size_t)]


class Accounting(c.Structure):
    _fields_ = [("user", c.c_longlong), ("kernel", c.c_longlong),
                ("period_user", c.c_longlong), ("period_kernel", c.c_longlong),
                ("faults", w.DWORD), ("total", w.DWORD), ("active", w.DWORD), ("terminated", w.DWORD)]


class JobPids(c.Structure):
    _fields_ = [("assigned", w.DWORD), ("count", w.DWORD), ("pids", c.c_size_t * 128)]


class Startup(c.Structure):
    _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR), ("title", w.LPWSTR),
                *[(name, w.DWORD) for name in ("x", "y", "x_size", "y_size", "x_chars", "y_chars", "fill", "flags")],
                ("show", w.WORD), ("reserved_count", w.WORD), ("reserved_bytes", c.c_void_p),
                ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE)]


class ProcessInfo(c.Structure):
    _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]


def main():
    report, raw_limit, executable, *arguments = sys.argv[1:]
    limit = int(raw_limit)
    if os.name != "nt" or not 1 <= limit <= 128:
        raise RuntimeError("Windows job requires a process limit from 1 through 128")
    kernel = c.WinDLL("kernel32", use_last_error=True)

    def api(name, result, *args):
        function = getattr(kernel, name)
        function.restype, function.argtypes = result, args
        return function

    create_job = api("CreateJobObjectW", w.HANDLE, c.c_void_p, w.LPCWSTR)
    set_limits = api("SetInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD)
    assign = api("AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
    create = api("CreateProcessW", w.BOOL, w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p,
                 w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR, c.POINTER(Startup), c.POINTER(ProcessInfo))
    resume = api("ResumeThread", w.DWORD, w.HANDLE)
    wait = api("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
    exit_code = api("GetExitCodeProcess", w.BOOL, w.HANDLE, c.POINTER(w.DWORD))
    terminate = api("TerminateProcess", w.BOOL, w.HANDLE, w.UINT)
    terminate_job = api("TerminateJobObject", w.BOOL, w.HANDLE, w.UINT)
    query = api("QueryInformationJobObject", w.BOOL, w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p)
    close = api("CloseHandle", w.BOOL, w.HANDLE)
    std_handle = api("GetStdHandle", w.HANDLE, w.DWORD)
    inherit = api("SetHandleInformation", w.BOOL, w.HANDLE, w.DWORD, w.DWORD)
    exit_process = api("ExitProcess", None, w.UINT)

    def check(ok):
        if not ok:
            raise c.WinError(c.get_last_error())

    def record(value):
        target = Path(report)
        temporary = Path(str(target) + ".tmp")
        temporary.write_text(json.dumps(value) + "\n", encoding="utf-8")
        os.replace(temporary, target)

    job, process, thread = None, None, None
    result = 125
    try:
        job = create_job(None, None)
        check(job)
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000 | 0x0008  # KILL_ON_JOB_CLOSE | ACTIVE_PROCESS
        limits.basic.active_limit = limit
        check(set_limits(job, 9, c.byref(limits), c.sizeof(limits)))
        startup = Startup()
        startup.cb, startup.flags = c.sizeof(startup), 0x100
        for name, number in (("stdin", -10), ("stdout", -11), ("stderr", -12)):
            handle = std_handle(number & 0xFFFFFFFF)
            check(inherit(handle, 1, 1))
            setattr(startup, name, handle)
        info = ProcessInfo()
        command = c.create_unicode_buffer(subprocess.list2cmdline([executable, *arguments]))
        # No user code can execute until assignment and limits both succeed.
        check(create(which(executable) or executable, command, None, None, True, 0x00000004, None, None, c.byref(startup), c.byref(info)))
        process, thread = info.process, info.thread
        check(assign(job, process))
        record({"state": "started", "pid": info.pid, "processLimit": limit})
        check(resume(thread) != 0xFFFFFFFF)
        check(wait(process, 0xFFFFFFFF) == 0)
        status = w.DWORD()
        check(exit_code(process, c.byref(status)))
        result = status.value
        # Allow ordinary child-exit notifications to settle, then record any
        # containment intervention so the differential cannot count it as parity.
        pids = JobPids()
        descendants = []
        for _ in range(11):
            check(query(job, 3, c.byref(pids), c.sizeof(pids), None))
            descendants = [pid for pid in pids.pids[:pids.count] if pid != info.pid]
            if not descendants:
                break
            time.sleep(0.01)
        before_cleanup = Accounting()
        check(query(job, 1, c.byref(before_cleanup), c.sizeof(before_cleanup), None))
        check(terminate_job(job, result))
        accounting = Accounting()
        for _ in range(500):
            check(query(job, 1, c.byref(accounting), c.sizeof(accounting), None))
            if accounting.active == 0:
                break
            time.sleep(0.01)
        if accounting.active:
            raise RuntimeError("Windows job descendants did not terminate")
        record({"state": "finished", "pid": info.pid, "exitCode": result,
                "processLimit": limit, "totalProcesses": accounting.total, "activeAfterCleanup": accounting.active,
                "descendantsCleaned": len(descendants), "limitTerminations": before_cleanup.terminated})
    except BaseException as error:
        record({"state": "error", "message": str(error)})
        if process:
            terminate(process, 125)
        if job:
            terminate_job(job, 125)
        print("scriptc test Windows job: " + str(error), file=sys.stderr)
        result = 125
    finally:
        for handle in (thread, process, job):
            if handle:
                close(handle)
    exit_process(result)


if __name__ == "__main__":
    main()
