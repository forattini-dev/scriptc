#ifndef SCR_ISLAND_ALLOC_H
#define SCR_ISLAND_ALLOC_H

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

/* emmalloc may enlarge a live block to align a neighboring allocation.
 * QuickJS requires its size callback to remain stable until realloc/free.
 * Report the requested payload size and keep malloc's maximum alignment. */
typedef struct {
  _Alignas(max_align_t) size_t size;
} ScrIslandAllocHeader;

static inline void *scr_island_alloc_malloc(size_t size) {
  if (size > SIZE_MAX - sizeof(ScrIslandAllocHeader)) return NULL;
  ScrIslandAllocHeader *header = malloc(sizeof(*header) + size);
  if (!header) return NULL;
  header->size = size;
  return header + 1;
}

static inline void *scr_island_alloc_calloc(size_t count, size_t size) {
  if (size != 0 && count > SIZE_MAX / size) return NULL;
  size_t bytes = count * size;
  if (bytes > SIZE_MAX - sizeof(ScrIslandAllocHeader)) return NULL;
  ScrIslandAllocHeader *header = calloc(1, sizeof(*header) + bytes);
  if (!header) return NULL;
  header->size = bytes;
  return header + 1;
}

static inline void scr_island_alloc_free(void *ptr) {
  if (ptr) free((ScrIslandAllocHeader *)ptr - 1);
}

static inline void *scr_island_alloc_realloc(void *ptr, size_t size) {
  if (!ptr) return scr_island_alloc_malloc(size);
  if (size == 0) {
    scr_island_alloc_free(ptr);
    return NULL;
  }
  if (size > SIZE_MAX - sizeof(ScrIslandAllocHeader)) return NULL;
  ScrIslandAllocHeader *header = realloc((ScrIslandAllocHeader *)ptr - 1,
                                         sizeof(*header) + size);
  if (!header) return NULL;
  header->size = size;
  return header + 1;
}

static inline size_t scr_island_alloc_size(const void *ptr) {
  return ptr ? ((const ScrIslandAllocHeader *)ptr - 1)->size : 0;
}

#endif
