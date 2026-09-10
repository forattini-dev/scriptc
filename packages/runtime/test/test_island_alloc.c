#include "../src/scr_island_alloc.h"

#ifdef NDEBUG
#error "allocator regression checks require assertions"
#endif
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  for (size_t size = 1; size < 1024; size++) {
    unsigned char *ptr = scr_island_alloc_malloc(size);
    assert(ptr != NULL);
    assert((uintptr_t)ptr % _Alignof(max_align_t) == 0);
    memset(ptr, 0x5a, size);
    size_t before = scr_island_alloc_size(ptr);
    unsigned char *neighbor = scr_island_alloc_malloc(32);
    assert(neighbor != NULL);
    memset(neighbor, 0xa5, 32);
    assert(scr_island_alloc_size(ptr) == before);
    assert(before == size);
    scr_island_alloc_free(neighbor);
    assert(scr_island_alloc_size(ptr) == before);

    unsigned char *grown = scr_island_alloc_realloc(ptr, size + 1024);
    assert(grown != NULL);
    assert((uintptr_t)grown % _Alignof(max_align_t) == 0);
    for (size_t i = 0; i < size; i++) assert(grown[i] == 0x5a);
    assert(scr_island_alloc_size(grown) == size + 1024);
    assert(scr_island_alloc_realloc(grown, SIZE_MAX) == NULL);
    assert(scr_island_alloc_size(grown) == size + 1024);
    assert(grown[0] == 0x5a);

    ptr = scr_island_alloc_realloc(grown, size);
    assert(ptr != NULL);
    for (size_t i = 0; i < size; i++) assert(ptr[i] == 0x5a);
    assert(scr_island_alloc_size(ptr) == size);
    scr_island_alloc_free(ptr);
  }

  unsigned char *zeroed = scr_island_alloc_calloc(17, 19);
  assert(zeroed != NULL);
  assert(scr_island_alloc_size(zeroed) == 323);
  for (size_t i = 0; i < 323; i++) assert(zeroed[i] == 0);
  assert(scr_island_alloc_realloc(zeroed, 0) == NULL);
  assert(scr_island_alloc_malloc(SIZE_MAX) == NULL);
  assert(scr_island_alloc_calloc(SIZE_MAX, 2) == NULL);
  void *from_null = scr_island_alloc_realloc(NULL, 9);
  assert(from_null != NULL && scr_island_alloc_size(from_null) == 9);
  scr_island_alloc_free(from_null);
  scr_island_alloc_free(NULL);
  assert(scr_island_alloc_size(NULL) == 0);
  puts("stable allocator checks passed");
  return 0;
}
