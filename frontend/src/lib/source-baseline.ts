// A session's first observed source is its comparison baseline. Reloading the
// viewer must never reset it. A new session gets a new baseline after restart.
// This detects edits during inspection, not pre-existing binary/source mismatch.
export class SourceBaseline {
  private hashes = new Map<string, string>();
  private changed = new Set<string>();

  observe(path: string, hash: string): boolean {
    const original = this.hashes.get(path);
    if (original === undefined) this.hashes.set(path, hash);
    else if (original !== hash) this.changed.add(path);
    return this.hasChanged(path);
  }

  hasChanged(path: string): boolean {
    return this.changed.has(path);
  }
}
