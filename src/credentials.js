'use strict';

const { ADDRESS_RE } = require('./engine');

class CredentialVault {
  constructor(environment = process.env) {
    this.environment = environment;
    this.memory = null;
  }

  set({ apiKey, privateKeyPem, fromWallet }) {
    const next = {
      apiKey: String(apiKey || '').trim(),
      privateKeyPem: String(privateKeyPem || '').replaceAll('\\n', '\n').trim(),
      fromWallet: String(fromWallet || '').trim()
    };
    if (!next.apiKey || !/BEGIN PRIVATE KEY/.test(next.privateKeyPem) || !ADDRESS_RE.test(next.fromWallet)) throw new Error('API key, Ed25519 request-signing PEM, and linked Solana wallet are required.');
    this.memory = next;
    return this.status();
  }

  clear() {
    this.memory = null;
  }

  get() {
    return this.memory || {
      apiKey: String(this.environment.GMGN_API_KEY || '').trim(),
      privateKeyPem: String(this.environment.GMGN_PRIVATE_KEY || '').replaceAll('\\n', '\n').trim(),
      fromWallet: String(this.environment.GMGN_FROM_WALLET || '').trim()
    };
  }

  status() {
    const value = this.get();
    return {
      source: this.memory ? 'memory' : 'environment',
      hasApiKey: Boolean(value.apiKey),
      hasPrivateKey: /BEGIN PRIVATE KEY/.test(value.privateKeyPem),
      hasFromWallet: ADDRESS_RE.test(value.fromWallet),
      complete: Boolean(value.apiKey && /BEGIN PRIVATE KEY/.test(value.privateKeyPem) && ADDRESS_RE.test(value.fromWallet))
    };
  }
}

module.exports = { CredentialVault };
