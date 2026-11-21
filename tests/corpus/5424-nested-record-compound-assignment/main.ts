class MemoryStorage {
  private compressionStats = {
    totalCompressed: 0,
    totalOriginalSize: 0,
    totalCompressedSize: 0,
  }

  record(originalSize: number, compressedSize: number) {
    this.compressionStats.totalCompressed++
    this.compressionStats.totalOriginalSize += originalSize
    this.compressionStats.totalCompressedSize += compressedSize
  }

  summary() {
    const stats: {
      totalCompressed: number
      totalOriginalSize: number
      totalCompressedSize: number
    } = this.compressionStats
    return `${stats.totalCompressed}:${stats.totalOriginalSize}:${stats.totalCompressedSize}`
  }
}

const storage = new MemoryStorage()
storage.record(100, 40)
storage.record(50, 20)
console.log(storage.summary())
