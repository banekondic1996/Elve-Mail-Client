// js/crypto.js — AES-256 encryption for stored credentials using Web Crypto API

const Vault = (() => {
  const STORAGE_KEY = 'elve_vault_v2';
  const SALT_KEY    = 'elve_salt_v2';
  let masterKey = null;

  // Derive AES key from password using PBKDF2
  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function getSalt() {
    const stored = localStorage.getItem(SALT_KEY);
    if (stored) return new Uint8Array(JSON.parse(stored));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    localStorage.setItem(SALT_KEY, JSON.stringify(Array.from(salt)));
    return salt;
  }

  function hasVault() {
    return !!localStorage.getItem(STORAGE_KEY);
  }

  async function unlock(password) {
    const salt = getSalt();
    masterKey  = await deriveKey(password, salt);
    // Verify password is correct if vault exists
    if (hasVault()) {
      try {
        const data = await loadAccounts();
        return { ok: true, accounts: data };
      } catch(e) {
        masterKey = null;
        return { ok: false, error: 'Wrong password' };
      }
    }
    return { ok: true, accounts: [] };
  }

  async function encrypt(obj) {
    if (!masterKey) throw new Error('Vault locked');
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const enc  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, masterKey, data);
    return JSON.stringify({
      iv:   Array.from(iv),
      data: Array.from(new Uint8Array(enc))
    });
  }

  async function decrypt(str) {
    if (!masterKey) throw new Error('Vault locked');
    const { iv, data } = JSON.parse(str);
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      masterKey,
      new Uint8Array(data)
    );
    return JSON.parse(new TextDecoder().decode(dec));
  }

  async function saveAccounts(accounts) {
    const enc = await encrypt(accounts);
    localStorage.setItem(STORAGE_KEY, enc);
  }

  async function loadAccounts() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    return decrypt(stored);
  }

  async function addAccount(config) {
    const accounts = await loadAccounts();
    const existing = accounts.findIndex(a => a.email === config.email && a.provider === config.provider);
    if (existing >= 0) accounts[existing] = config;
    else accounts.push(config);
    await saveAccounts(accounts);
    return accounts;
  }

  async function _decryptWithPassword(password) {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) throw new Error('Vault not initialized');
    const salt = getSalt();
    const key = await deriveKey(password, salt);
    const { iv, data } = JSON.parse(stored);
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(data)
    );
    return JSON.parse(new TextDecoder().decode(dec));
  }

  async function verifyPassword(password) {
    try {
      await _decryptWithPassword(password);
      return { ok: true };
    } catch(_) {
      return { ok: false, error: 'Wrong current password' };
    }
  }

  async function changePassword(currentPassword, newPassword) {
    let accounts;
    try {
      accounts = await _decryptWithPassword(currentPassword);
    } catch(_) {
      return { ok: false, error: 'Wrong current password' };
    }

    // Re-encrypt with a brand new salt and key.
    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    localStorage.setItem(SALT_KEY, JSON.stringify(Array.from(newSalt)));
    masterKey = await deriveKey(newPassword, newSalt);
    await saveAccounts(accounts);
    return { ok: true };
  }

  function lock() { masterKey = null; }

  return { hasVault, unlock, addAccount, loadAccounts, saveAccounts, verifyPassword, changePassword, lock };
})();
