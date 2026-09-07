/* Runtime-owned clock/sleep seams. Zig's MinGW headers do not provide
 * clock_gettime/nanosleep; use Win32 directly without a winpthreads dependency.
 * Include after a unit's Winsock headers, if any (windows.h imports Winsock 1). */
#ifndef SCR_TIME_H
#define SCR_TIME_H

#include <errno.h>
#include <stdint.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#endif

static inline double scr_clock_monotonic_ms(void) {
#ifdef _WIN32
  LARGE_INTEGER ticks, frequency;
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&ticks);
  return (double)ticks.QuadPart * (1000.0 / (double)frequency.QuadPart);
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}

static inline double scr_clock_realtime_ms(void) {
#ifdef _WIN32
  FILETIME time;
  ULARGE_INTEGER ticks;
  GetSystemTimeAsFileTime(&time);
  ticks.LowPart = time.dwLowDateTime;
  ticks.HighPart = time.dwHighDateTime;
  /* FILETIME counts 100ns intervals from 1601; JavaScript uses 1970. */
  return (double)((int64_t)ticks.QuadPart - INT64_C(116444736000000000)) / 10000.0;
#else
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}

static inline int scr_nanosleep(const struct timespec *request, struct timespec *remaining) {
#ifdef _WIN32
  if (request->tv_sec < 0 || request->tv_nsec < 0 || request->tv_nsec >= 1000000000L) {
    errno = EINVAL;
    return -1;
  }
  double ms = (double)request->tv_sec * 1000.0 + (double)request->tv_nsec / 1e6;
  /* Keep each DWORD finite, and round up so a sub-ms delay cannot end early. */
  const DWORD chunk = INFINITE - 1;
  while (ms > (double)chunk) {
    Sleep(chunk);
    ms -= (double)chunk;
  }
  DWORD whole = (DWORD)ms;
  if ((double)whole < ms) whole++;
  Sleep(whole);
  if (remaining) *remaining = (struct timespec){0, 0};
  return 0;
#else
  return nanosleep(request, remaining);
#endif
}

#endif
