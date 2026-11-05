// Fixed-capacity ring buffer for telemetry samples (SPEC-PHASE2 §2.4).
// Drops oldest beyond capacity; tail(n) returns the last n items oldest → newest.

export class RingBuffer<T> {
  private items: T[] = []
  private readonly capacity: number

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`)
    }
    this.capacity = capacity
  }

  push(item: T): void {
    this.items.push(item)
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity)
    }
  }

  tail(n?: number): T[] {
    if (n === undefined || n >= this.items.length) return [...this.items]
    if (n <= 0) return []
    return this.items.slice(this.items.length - n)
  }

  size(): number {
    return this.items.length
  }

  clear(): void {
    this.items = []
  }
}
