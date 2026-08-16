'use strict';

class TokenBucket {
  constructor({ capacity = 4, refillPerSecond = 4, clock = () => Date.now(), waitImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.capacity = capacity; this.tokens = capacity; this.refillPerSecond = refillPerSecond;
    this.clock = clock; this.wait = waitImpl; this.updatedAt = clock(); this.totalWaitMs = 0;
    this.admissionTail = Promise.resolve();
  }

  _refill() {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed / 1000 * this.refillPerSecond);
    this.updatedAt = now;
  }

  take() {
    const admission = this.admissionTail.then(() => this._takeOne());
    this.admissionTail = admission.catch(() => {});
    return admission;
  }

  async _takeOne() {
    this._refill();
    if (this.tokens >= 1) { this.tokens -= 1; return 0; }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerSecond * 1000);
    this.totalWaitMs += waitMs;
    await this.wait(waitMs);
    this._refill(); this.tokens = Math.max(0, this.tokens - 1);
    return waitMs;
  }

  status() { this._refill(); return { tokens: this.tokens, capacity: this.capacity, refillPerSecond: this.refillPerSecond, totalWaitMs: this.totalWaitMs }; }
}

class PriorityScheduler {
  constructor({
    name = 'provider', maxConcurrency = 3, maxQueueSize = 300, reserveExitFraction = 0,
    rateLimitCapacity = 4, requestsPerSecond = 4, clock = () => Date.now(), waitImpl
  } = {}) {
    this.name = name;
    this.maxConcurrency = Math.max(1, Math.trunc(maxConcurrency));
    this.maxQueueSize = Math.max(1, Math.trunc(maxQueueSize));
    this.entryConcurrency = Math.max(1, Math.floor(this.maxConcurrency * (1 - Math.max(0, Math.min(0.95, reserveExitFraction)))));
    this.bucket = new TokenBucket({ capacity: rateLimitCapacity, refillPerSecond: requestsPerSecond, clock, waitImpl });
    this.queues = { exit: [], normal: [], entry: [] };
    this.active = 0;
    this.activeEntries = 0;
    this.metrics = { submitted: 0, completed: 0, rejected: 0, peakQueue: 0 };
  }

  get queueDepth() { return this.queues.exit.length + this.queues.normal.length + this.queues.entry.length; }
  get exitPending() { return this.queues.exit.length > 0; }

  submit(task, { priority = 'normal' } = {}) {
    const lane = priority === 'exit' ? 'exit' : priority === 'entry' ? 'entry' : 'normal';
    if (this.queueDepth >= this.maxQueueSize) {
      if (lane === 'exit' && this.queues.entry.length) {
        const preempted = this.queues.entry.pop();
        this.metrics.rejected += 1;
        preempted.reject(Object.assign(new Error(`${this.name} entry queue preempted by an exit.`), { code: 'QUEUE_PREEMPTED' }));
      } else {
        this.metrics.rejected += 1;
        return Promise.reject(Object.assign(new Error(`${this.name} queue is full.`), { code: 'QUEUE_FULL' }));
      }
    }
    this.metrics.submitted += 1;
    return new Promise((resolve, reject) => {
      this.queues[lane].push({ task, resolve, reject, lane });
      this.metrics.peakQueue = Math.max(this.metrics.peakQueue, this.queueDepth);
      this._drain();
    });
  }

  _next() {
    if (this.queues.exit.length) return this.queues.exit.shift();
    if (this.queues.normal.length) return this.queues.normal.shift();
    if (this.queues.entry.length && this.activeEntries < this.entryConcurrency) return this.queues.entry.shift();
    return null;
  }

  _drain() {
    while (this.active < this.maxConcurrency) {
      const item = this._next();
      if (!item) return;
      this.active += 1;
      if (item.lane === 'entry') this.activeEntries += 1;
      Promise.resolve()
        .then(() => this.bucket.take())
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          if (item.lane === 'entry') this.activeEntries -= 1;
          this.metrics.completed += 1;
          this._drain();
        });
    }
  }

  status() {
    return {
      name: this.name, active: this.active, activeEntries: this.activeEntries,
      queueDepth: this.queueDepth, exitQueueDepth: this.queues.exit.length,
      entryQueueDepth: this.queues.entry.length, maxQueueSize: this.maxQueueSize,
      maxConcurrency: this.maxConcurrency, entryConcurrency: this.entryConcurrency,
      ...this.metrics, rateLimit: this.bucket.status()
    };
  }
}

module.exports = { PriorityScheduler, TokenBucket };
