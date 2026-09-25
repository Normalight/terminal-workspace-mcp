// Capacity includes in-progress handshakes. Admission and removal are
// synchronous so concurrent initialize requests cannot oversubscribe the pool.
export class HttpSessionPool {
  constructor({ max, idleTtlMs, pressureIdleMs, now = Date.now, onRemove = () => {} }) {
    Object.assign(this, { max, idleTtlMs, pressureIdleMs, now, onRemove });
    this.sessions = new Map();
    this.reserved = 0;
  }
  idleAge(session) { return this.now() - (session.lastActiveAt ?? session.createdAt); }
  protected(session) { return (session.inflight ?? 0) > 0 || !!session.transport?.notificationStreamOpen; }
  remove(id, reason) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.onRemove(id, session, reason, this.idleAge(session));
    return true;
  }
  expire() {
    for (const [id, session] of this.sessions) {
      if (!this.protected(session) && this.idleAge(session) >= this.idleTtlMs) this.remove(id, 'expired');
    }
  }
  reserve() {
    this.expire();
    if (this.sessions.size + this.reserved >= this.max) {
      const candidate = [...this.sessions].filter(([, s]) => !this.protected(s) && this.idleAge(s) >= this.pressureIdleMs)
        .sort(([, a], [, b]) => (a.lastActiveAt ?? a.createdAt) - (b.lastActiveAt ?? b.createdAt))[0];
      if (candidate) this.remove(candidate[0], 'capacity');
    }
    if (this.sessions.size + this.reserved >= this.max) return null;
    this.reserved++;
    let pending = true;
    const release = () => { if (pending) { pending = false; this.reserved--; } };
    return {
      activate: (id, session) => {
        if (!pending) throw Error('HTTP session reservation already released');
        release(); this.sessions.set(id, session);
      },
      release,
    };
  }
  stats() {
    let inflight = 0, listeners = 0, reclaimable = 0, oldestIdleMs = 0;
    for (const session of this.sessions.values()) {
      inflight += session.inflight ?? 0;
      if (session.transport?.notificationStreamOpen) listeners++;
      if (!this.protected(session) && this.idleAge(session) >= this.pressureIdleMs) reclaimable++;
      oldestIdleMs = Math.max(oldestIdleMs, this.idleAge(session));
    }
    return { active: this.sessions.size, reserved: this.reserved, max: this.max, inflight, listeners, reclaimable, oldestIdleMs };
  }
}
