/**
 * Bansos Gateway - Pure public-host policy module
 * No database, no async, no I/O. Pure functions for policy validation.
 */

import { BANSOS_HOST, PUBLIC_MODEL } from './constants.js';

/**
 * Internal helper: Parse a Host header value into components.
 * Returns an object with hostPart (normalized, no brackets/port), port, and flags.
 * Only strips brackets for actual IP literals, rejecting bracket-wrapped hostnames.
 * @private
 * @param {*} host - The Host header value (may not be a string)
 * @returns {Object} {hostPart, port, isIPLiteral, isValid}
 */
function _parseHostAndPort(host) {
  // Guard against non-string input
  if (typeof host !== 'string') {
    return { hostPart: '', port: null, isIPLiteral: false, isValid: false };
  }

  let hostPart = host;
  let port = null;
  let isIPLiteral = false;

  if (host.startsWith('[')) {
    // Bracket notation: [ipv6]:port or [ipv6]
    const endBracket = host.indexOf(']');
    if (endBracket !== -1) {
      const bracketed = host.substring(1, endBracket);
      // Only treat as IP literal if contents contain a colon (IPv6 indicator)
      if (bracketed.includes(':')) {
        hostPart = bracketed;
        isIPLiteral = true;
        // Extract port after ]
        if (host.length > endBracket + 1 && host[endBracket + 1] === ':') {
          port = host.substring(endBracket + 2);
        }
      } else {
        // Bracket-wrapped non-IP hostname (invalid form)
        return { hostPart: host, port: null, isIPLiteral: false, isValid: false };
      }
    }
  } else if (host.includes(':')) {
    // Could be host:port or bare IPv6
    if (host.includes('::')) {
      // Bare IPv6 (contains ::)
      hostPart = host;
      isIPLiteral = true;
    } else {
      // Check for exactly one colon (host:port); reject multiple colons
      const colonCount = (host.match(/:/g) || []).length;
      if (colonCount === 1) {
        // host:port (exactly one colon)
        const parts = host.split(':');
        hostPart = parts[0];
        port = parts[1];
      } else {
        // Multiple colons without :: pattern (invalid/ambiguous)
        return { hostPart: host, port: null, isIPLiteral: false, isValid: false };
      }
    }
  }

  return { hostPart, port, isIPLiteral, isValid: true };
}

/**
 * Normalize a Host header value.
 * Handles: mixed case, explicit port suffixes, IPv6 literals with brackets.
 * @param {string} host - The Host header value
 * @returns {string} Normalized hostname (lowercase, no port, no brackets)
 */
export function normalizeHost(host) {
  const parsed = _parseHostAndPort(host);
  if (!parsed.isValid) {
    // Return as-is (will be lowercased) if it's invalid bracket syntax
    return typeof host === 'string' ? host.toLowerCase() : '';
  }
  return parsed.hostPart.toLowerCase();
}

/**
 * Check if a Host header value refers to the Bansos public host.
 * Returns true for: api.priaoslo.web.id (case-insensitive, optional :443)
 * Returns false for: any other host, non-standard ports, IPv6 literals, non-string input
 * @param {*} host - The Host header value
 * @returns {boolean} True if this is the Bansos host
 */
export function isBansosHost(host) {
  // Guard against non-string input
  if (typeof host !== 'string') {
    return false;
  }

  const parsed = _parseHostAndPort(host);

  // Reject invalid bracket syntax (e.g., [hostname]:port)
  if (!parsed.isValid) {
    return false;
  }

  // Reject bare IPv6 addresses (they don't match the bansos host)
  if (parsed.isIPLiteral) {
    return false;
  }

  // Check if normalized host matches BANSOS_HOST
  const normalized = parsed.hostPart.toLowerCase();
  if (normalized !== BANSOS_HOST) {
    return false;
  }

  // If there's a port, it must be :443 (standard HTTPS) or absent
  if (parsed.port !== null && parsed.port !== '443') {
    return false;
  }

  return true;
}

/**
 * Check if a method+path pair is allowlisted for Bansos requests.
 * Allows both pre-rewrite (/v1/*) and post-rewrite (/api/v1/*) forms.
 * @param {*} method - HTTP method (GET, POST, etc.)
 * @param {*} path - Request path
 * @returns {boolean} True if this endpoint is allowed
 */
export function isAllowedBansosEndpoint(method, path) {
  // Guard against non-string input
  if (typeof method !== 'string' || typeof path !== 'string') {
    return false;
  }

  // Only GET and POST are allowed
  if (method !== 'GET' && method !== 'POST') {
    return false;
  }

  // Extract the path part (handle query strings if present)
  const pathOnly = path.split('?')[0];

  // Normalize path: if it starts with /api/v1/, remove /api prefix to standardize
  const normalizedPath = pathOnly.startsWith('/api/v1/')
    ? pathOnly.substring(4) // Remove '/api' to get '/v1/...'
    : pathOnly;

  // Check allowed endpoints
  if (method === 'GET' && normalizedPath === '/v1/models') {
    return true;
  }

  if (method === 'POST' && normalizedPath === '/v1/chat/completions') {
    return true;
  }

  return false;
}

/**
 * Validate that a model identifier is the public Bansos model.
 * Only exact match is accepted; case-sensitive, no whitespace tolerance.
 * @param {string} model - Model identifier to validate
 * @returns {boolean} True if this is the public Bansos model
 */
export function validateBansosModel(model) {
  return model === PUBLIC_MODEL;
}

/**
 * Construct an OpenAI-compatible error response envelope for Bansos requests.
 * @param {number} status - HTTP status code
 * @param {string} message - Human-readable error message
 * @param {string} type - Error type (e.g., 'rate_limit_error', 'invalid_request_error')
 * @param {string} code - Machine-readable error code (e.g., 'concurrency_limit_exceeded')
 * @param {Object} [extraHeaders] - Optional additional response headers (e.g., Retry-After)
 * @returns {Object} Response object with status, body (JSON error envelope), and optional headers
 */
export function bansosError(status, message, type, code, extraHeaders) {
  const result = {
    status,
    body: {
      error: {
        message,
        type,
        code,
      },
    },
  };

  if (extraHeaders !== undefined) {
    result.headers = extraHeaders;
  }

  return result;
}
