import crypto from 'node:crypto'
import Settings from '@overleaf/settings'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

function getEncryptionKey() {
  const rawSecret =
    process.env.OVERLEAF_AI_ENCRYPTION_KEY ||
    Settings?.security?.sessionSecret ||
    'overleaf-ai-assistant-default-secret'
  return crypto.createHash('sha256').update(String(rawSecret)).digest()
}

/**
 * Encrypts a plaintext secret using AES-256-GCM.
 * Returns a base64-encoded string of `iv:authTag:ciphertext`.
 * @param {string} plaintext
 * @returns {string}
 */
export function encryptSecret(plaintext) {
  if (!plaintext) return ''
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`
}

/**
 * Decrypts a secret produced by `encryptSecret`.
 * @param {string} payload
 * @returns {string}
 */
export function decryptSecret(payload) {
  if (!payload) return ''
  const parts = String(payload).split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret format')
  }
  const [ivB64, authTagB64, dataB64] = parts
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(ivB64, 'base64')
  )
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  return decrypted.toString('utf8')
}

/**
 * Masks an API key for safe display in the UI.
 * @param {string} key
 * @returns {string}
 */
export function maskSecret(key) {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

/**
 * Generates a new random MCP bearer token and its SHA-256 hash.
 */
export function generateMcpToken() {
  const raw = `olmcp_${crypto.randomBytes(32).toString('hex')}`
  const tokenHash = hashToken(raw)
  const tokenPrefix = `${raw.slice(0, 12)}...${raw.slice(-4)}`
  return { raw, tokenHash, tokenPrefix }
}

/**
 * Computes SHA-256 hex digest of a bearer token.
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}
