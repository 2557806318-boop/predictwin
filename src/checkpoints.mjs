export class CheckpointScheduler {
  #checkpoints;
  #windowMs;
  #fired = new Set();

  constructor(checkpointsSeconds, windowMs = 1_000) {
    this.#checkpoints = [...checkpointsSeconds].sort((a, b) => b - a);
    this.#windowMs = windowMs;
  }

  due(round, nowMs) {
    const remainingMs = round.endTimeMs - nowMs;
    if (remainingMs < -this.#windowMs) return null;
    for (const seconds of this.#checkpoints) {
      const key = `${round.roundId}:${seconds}`;
      if (!this.#fired.has(key) && Math.abs(remainingMs - seconds * 1_000) <= this.#windowMs) {
        this.#fired.add(key);
        return seconds;
      }
    }
    return null;
  }

  hasFired(roundId, seconds) {
    return this.#fired.has(`${roundId}:${seconds}`);
  }

  prune(activeRoundIds) {
    const active = new Set(activeRoundIds);
    for (const key of this.#fired) {
      const separator = key.lastIndexOf(':');
      if (!active.has(key.slice(0, separator))) this.#fired.delete(key);
    }
  }
}

