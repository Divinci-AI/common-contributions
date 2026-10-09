/** Two stores with one interface: memory (tests, local) and Cloudflare D1 (the Worker). */

export class MemoryStore {
  constructor() { this.rows = new Map(); }
  async insert(rec) {
    for (const r of this.rows.values()) if (r.dedupeKey === rec.dedupeKey) return { duplicateOf: r.id };
    this.rows.set(rec.id, { ...rec });
    return { ok: true };
  }
  async get(id) { const r = this.rows.get(id); return r ? { ...r } : null; }
  async list(status) {
    return [...this.rows.values()].filter((r) => !status || r.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({ ...r }));
  }
  async update(id, patch) {
    const r = this.rows.get(id);
    if (!r) return null;
    Object.assign(r, patch);
    return { ...r };
  }
}

const fromRow = (r) => r && ({
  id: r.id, dedupeKey: r.dedupe_key, status: r.status, project: r.project, url: r.url, kind: r.kind, relationship: r.relationship,
  work: r.work, policyUrl: r.policy_url, submittedBy: r.submitted_by, consentUrl: r.consent_url, note: r.note,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export class D1Store {
  constructor(db) { this.db = db; }
  async insert(r) {
    const dup = await this.db.prepare("SELECT id FROM proposals WHERE dedupe_key = ?").bind(r.dedupeKey).first();
    if (dup) return { duplicateOf: dup.id };
    try {
      await this.db.prepare(
        "INSERT INTO proposals (id, dedupe_key, status, project, url, kind, relationship, work, policy_url, submitted_by, consent_url, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(r.id, r.dedupeKey, r.status, r.project, r.url, r.kind, r.relationship, r.work, r.policyUrl, r.submittedBy, r.consentUrl, r.note, r.createdAt, r.updatedAt).run();
    } catch (e) {
      // A concurrent insert of the same project loses the UNIQUE race; report it as the duplicate it is.
      const again = await this.db.prepare("SELECT id FROM proposals WHERE dedupe_key = ?").bind(r.dedupeKey).first();
      if (again) return { duplicateOf: again.id };
      throw e;
    }
    return { ok: true };
  }
  async get(id) { return fromRow(await this.db.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first()); }
  async list(status) {
    const q = status ? this.db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT 500").bind(status)
      : this.db.prepare("SELECT * FROM proposals ORDER BY created_at DESC LIMIT 500");
    return (await q.all()).results.map(fromRow);
  }
  async update(id, p) {
    await this.db.prepare("UPDATE proposals SET status = ?, consent_url = ?, note = ?, updated_at = ? WHERE id = ?")
      .bind(p.status, p.consentUrl, p.note, p.updatedAt, id).run();
    return this.get(id);
  }
}
