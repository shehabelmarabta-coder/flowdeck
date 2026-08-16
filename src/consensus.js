'use strict';

class RollingConsensus {
  constructor({ wallets, normalWindowMs = 60_000, strongWindowMs = 45_000, clock = () => Date.now() }) {
    this.clock = clock;
    this.normalWindowMs = normalWindowMs;
    this.strongWindowMs = strongWindowMs;
    this.weights = new Map(wallets.filter((wallet) => wallet.enabled !== false).map((wallet) => [wallet.address, Number(wallet.weight || wallet.finalWeight || 1)]));
    this.totalWeight = [...this.weights.values()].reduce((sum, weight) => sum + weight, 0);
    this.byMint = new Map();
    this.seenSignatures = new Map();
  }

  _prune(now = this.clock()) {
    const cutoff = now - this.normalWindowMs;
    for (const [mint, votes] of this.byMint) {
      for (const [wallet, vote] of votes) if (vote.at < cutoff) votes.delete(wallet);
      if (!votes.size) this.byMint.delete(mint);
    }
    for (const [signature, at] of this.seenSignatures) if (at < cutoff) this.seenSignatures.delete(signature);
  }

  ingest({ mint, wallet, signature = '', observedAt }) {
    const now = this.clock();
    this._prune(now);
    if (!this.weights.has(wallet)) return { status: 'filtered', reason: 'wallet-not-enabled' };
    const id = String(signature || '');
    if (id && this.seenSignatures.has(id)) return { status: 'duplicate', reason: 'duplicate-signature' };
    if (id) this.seenSignatures.set(id, now);
    if (!this.byMint.has(mint)) this.byMint.set(mint, new Map());
    const votes = this.byMint.get(mint);
    if (votes.has(wallet)) return { status: 'duplicate', reason: 'wallet-already-voted-in-window' };
    votes.set(wallet, { wallet, weight: this.weights.get(wallet), at: Number.isFinite(Number(observedAt)) ? Number(observedAt) : now, signature: id });
    return { status: 'accepted', consensus: this.snapshot(mint) };
  }

  snapshot(mint, now = this.clock()) {
    this._prune(now);
    const votes = [...(this.byMint.get(mint)?.values() || [])];
    const normal = votes.filter((vote) => vote.at >= now - this.normalWindowMs);
    const strong = votes.filter((vote) => vote.at >= now - this.strongWindowMs);
    const summarize = (items) => {
      const weight = items.reduce((sum, item) => sum + item.weight, 0);
      return { walletCount: items.length, weight, weightedConsensusPct: this.totalWeight > 0 ? weight / this.totalWeight * 100 : 0 };
    };
    return { mint, totalEnabledWeight: this.totalWeight, normal: summarize(normal), strong: summarize(strong), voters: normal.map((vote) => vote.wallet) };
  }
}

module.exports = { RollingConsensus };
