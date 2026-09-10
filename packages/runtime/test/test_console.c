/* Force scheduling opportunities between the real formatter's stdio calls.
 * Locking one complete message must work even if a writer yields mid-line. */
#include <pthread.h>
#include <sched.h>
#include <stdio.h>

static size_t yielding_fwrite(const void *p, size_t size, size_t n, FILE *out) {
  size_t written = fwrite(p, size, n, out);
  sched_yield();
  return written;
}

static int yielding_fputc(int c, FILE *out) {
  int written = fputc(c, out);
  sched_yield();
  return written;
}

#define fwrite yielding_fwrite
#define fputc yielding_fputc
#include "../src/scr_console.c"
#undef fwrite
#undef fputc

static pthread_mutex_t start_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t start_cond = PTHREAD_COND_INITIALIZER;
static int ready = 0;

static void *write_lines(void *arg) {
  const int id = *(const int *)arg;
  pthread_mutex_lock(&start_mutex);
  ready++;
  pthread_cond_broadcast(&start_cond);
  while (ready != 4) pthread_cond_wait(&start_cond, &start_mutex);
  pthread_mutex_unlock(&start_mutex);
  for (int i = 0; i < 128; i++) {
    const ScrLogArg args[] = {
      {.tag = SCR_ARG_F64, .v.f = id},
      {.tag = SCR_ARG_F64, .v.f = i},
      {.tag = SCR_ARG_BOOL, .v.b = true},
      {.tag = SCR_ARG_F64, .v.f = -0.0},
    };
    scr_console_log(4, args);
    scr_console_error(4, args);
  }
  return NULL;
}

int main(void) {
  pthread_t threads[4];
  int ids[] = {0, 1, 2, 3};
  for (int i = 0; i < 4; i++) {
    if (pthread_create(&threads[i], NULL, write_lines, &ids[i]) != 0) return 2;
  }
  for (int i = 0; i < 4; i++) {
    if (pthread_join(threads[i], NULL) != 0) return 3;
  }
  return 0;
}
