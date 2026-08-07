/**
 * Bansos Gateway - Pure public-host policy module
 * No database, no async, no I/O. Pure functions for policy validation.
 */

import { BANSOS_HOST, PUBLIC_MODEL } from './constants.js';

/**
 * Normalize a Host header value.
 * Handles: mixed case, explicit port suffixes, IPv6 literals with brackets.
 * @param {string} host - The Host header value
 * @returns {string} Normalized hostname (lowercase, no port, no brackets)
 */
export function normalizeHost(host) {
  let normalized = host;

  // Handle IPv6 with brackets: [::1]:port or [::1]
  if (host.startsWith('[')) {
    const endBracket = host.indexOf(']');
    if (endBracket !== -1) {
      normalized = host.substring(1, endBracket);
    }
  } else if (host.includes(':')) {
    // Check if it's bare IPv6 (contains ::) or host:port
    if (!host.includes('::')) {
      // host:port, extract host (everything before first :)
      normalized = host.split(':')[0];
    }
    // else: bare IPv6, keep as-is
  }

  return normalized.toLowerCase();
}

/**
 * Check if a Host header value refers to the Bansos public host.
 * Returns true for: api.priaoslo.web.id (case-insensitive, optional :443)
 * Returns false for: any other host, non-standard ports, IPv6 literals
 * @param {string} host - The Host header value
 * @returns {boolean} True if this is the Bansos host
 */
export function isBansosHost(host) {
  const normalized = normalizeHost(host);

  if (normalized !== BANSOS_HOST) {
    return false;
  }

  // If the original host contains a port, verify it's allowed (:443 is standard HTTPS)
  let hasNonStandardPort = false;

  if (host.startsWith('[')) {
    // IPv6 with brackets: [host]:port
    const endBracket = host.indexOf(']');
    if (endBracket !== -1 && host.length > endBracket + 1) {
      const afterBracket = host.substring(endBracket + 1);
      if (afterBracket.startsWith(':') && afterBracket !== ':443') {
        hasNonStandardPort = true;
      }
    }
  } else {
    // Regular host (possibly with port)
    // Count colons: if > 1, it's bare IPv6 (not allowed for bansos host match)
    const colonCount = (host.match(/:/g) || []).length;
    if (colonCount === 1) {
      // One colon means host:port
      const port = host.split(':')[1];
      if (port !== '443') {
        hasNonStandardPort = true;
      }
    } else if (colonCount > 1) {
      // Multiple colons mean bare IPv6 - can't be the bansos host
      return false;
    }
  }

  return !hasNonStandardPort;
}

/**
 * Check if a method+path pair is allowlisted for Bansos requests.
 * Allows both pre-rewrite (/v1/*) and post-rewrite (/api/v1/*) forms.
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} path - Request path
 * @returns {boolean} True if this endpoint is allowed
 */
export function isAllowedBansosEndpoint(method, path) {
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
