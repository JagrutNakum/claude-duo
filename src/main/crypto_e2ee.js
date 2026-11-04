const crypto = require('crypto');

const SALT = Buffer.from('claude-duo-e2ee-salt-v1');

function deriveKey(passphrase) {
  if (!passphrase) return null;
  return crypto.pbkdf2Sync(passphrase.trim(), SALT, 100000, 32, 'sha256');
}

function encryptPayload(payloadObj, key, seq = 0) {
  if (!key) return null;
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  
  const text = JSON.stringify(payloadObj);
  let ciphertext = cipher.update(text, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  
  return {
    nonce: nonce.toString('hex'),
    ciphertext,
    tag,
    seq
  };
}

function decryptPayload(envelope, key) {
  if (!key || !envelope || !envelope.ciphertext || !envelope.nonce || !envelope.tag) {
    return null;
  }
  try {
    const nonce = Buffer.from(envelope.nonce, 'hex');
    const tag = Buffer.from(envelope.tag, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(envelope.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (err) {
    return null;
  }
}

module.exports = {
  deriveKey,
  encryptPayload,
  decryptPayload
};
