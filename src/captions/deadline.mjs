/**
 * The time a request may take. The clock stops while an ad plays (an ad's length is not ours to shorten), but an
 * overall cap holds regardless: activeMs of our own work, hardMs in all.
 */
export class Deadline {
  #now;
  #start;
  #activeMs;
  #hardEnd;
  #adMs = 0;
  #adSince = null;

  constructor(activeMs, hardMs, now = () => performance.now()) {
    this.#now = now;
    this.#start = now();
    this.#activeMs = activeMs;
    this.#hardEnd = this.#start + hardMs;
  }

  /** tell it whether an ad is showing now */
  noteAd(showing) {
    const t = this.#now();
    if (showing && this.#adSince === null) this.#adSince = t;
    else if (!showing && this.#adSince !== null) {
      this.#adMs += t - this.#adSince;
      this.#adSince = null;
    }
  }

  adMs() {
    return this.#adMs + (this.#adSince === null ? 0 : this.#now() - this.#adSince);
  }

  end() {
    return Math.min(this.#start + this.#activeMs + this.adMs(), this.#hardEnd);
  }

  left() {
    return this.end() - this.#now();
  }

  elapsed() {
    return this.#now() - this.#start;
  }
}
