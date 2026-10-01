// /scribe transpose (party mode): telling apart party members who share one
// Discord user's mic, from the voice embedding the worker returns alongside
// each clip's transcript. Best-effort, not real diarization: one cluster per
// declared name, grown online as clips arrive, never more than declared.

export const DEFAULT_THRESHOLD = 0.75;

/** The Discord account behind a speakerId, whether or not it is split by /scribe transpose. */
export function rawSpeakerId(speakerId) {
  const i = speakerId.indexOf(':');
  return i === -1 ? speakerId : speakerId.slice(0, i);
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Online clustering of one Discord user's clip embeddings into their
 * declared party members. A cluster is a running mean embedding; a new clip
 * joins the nearest one, or starts a fresh cluster (taking the next unused
 * declared name) while there is a name still spare.
 */
export class SpeakerClusters {
  /**
   * @param {string[]} names declared party members, in the order to assign them
   * @param {{name:string, centroid:number[], count:number}[]} clusters resolved so far
   * @param {number} threshold cosine similarity below which a new cluster starts
   */
  constructor(names, clusters = [], threshold = DEFAULT_THRESHOLD) {
    this.names = names;
    this.clusters = clusters;
    this.threshold = threshold;
  }

  static restore(state, threshold = DEFAULT_THRESHOLD) {
    return new SpeakerClusters(
      state.names,
      state.clusters.map((c) => ({ ...c, centroid: [...c.centroid] })),
      threshold,
    );
  }

  #spawn(embedding) {
    const used = new Set(this.clusters.map((c) => c.name));
    const name = this.names.find((n) => !used.has(n)) ?? this.names[this.clusters.length % this.names.length];
    const cluster = { name, centroid: [...embedding], count: 1 };
    this.clusters.push(cluster);
    return { name, index: this.clusters.length - 1 };
  }

  /** @param {number[]} embedding @returns {{name: string, index: number}} */
  assign(embedding) {
    if (!this.clusters.length) return this.#spawn(embedding);
    let best = 0;
    let bestSim = cosineSimilarity(embedding, this.clusters[0].centroid);
    for (let i = 1; i < this.clusters.length; i++) {
      const sim = cosineSimilarity(embedding, this.clusters[i].centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = i;
      }
    }
    if (bestSim < this.threshold && this.clusters.length < this.names.length) return this.#spawn(embedding);
    const c = this.clusters[best];
    c.centroid = c.centroid.map((v, i) => (v * c.count + embedding[i]) / (c.count + 1));
    c.count++;
    return { name: c.name, index: best };
  }

  get state() {
    return { names: this.names, clusters: this.clusters.map((c) => ({ ...c, centroid: [...c.centroid] })) };
  }
}
