import { describe, it, expect } from 'vitest';
import {
  BANSOS_HOST,
  PUBLIC_MODEL,
  INTERNAL_MODEL,
  BANSOS_LIMITS,
} from '../../src/lib/bansos/constants.js';
import {
  normalizeHost,
  isBansosHost,
  isAllowedBansosEndpoint,
  validateBansosModel,
  bansosError,
} from '../../src/lib/bansos/policy.js';

describe('bansos-policy', () => {
  describe('constants', () => {
    it('should export correct host and model constants', () => {
      expect(BANSOS_HOST).toBe('api.priaoslo.web.id');
      expect(PUBLIC_MODEL).toBe('bansos/grok-4.5');
      expect(INTERNAL_MODEL).toBe('gcli/grok-4.5');
    });

    it('should export BANSOS_LIMITS with correct numeric values', () => {
      expect(BANSOS_LIMITS.maxRequestBody).toBe(2 * 1024 * 1024); // 2 MiB
      expect(BANSOS_LIMITS.firstResponseTimeoutMs).toBe(60 * 1000); // 60 seconds
      expect(BANSOS_LIMITS.maxStreamDurationMs).toBe(10 * 60 * 1000); // 10 minutes
      expect(BANSOS_LIMITS.maxPromptSize).toBe(64 * 1024); // 64 KiB
      expect(BANSOS_LIMITS.promptRetentionDays).toBe(7);
    });
  });

  describe('normalizeHost', () => {
    it('should lowercase the hostname', () => {
      expect(normalizeHost('API.PRIAOSLO.WEB.ID')).toBe('api.priaoslo.web.id');
      expect(normalizeHost('Api.PrIaOsLo.Web.Id')).toBe('api.priaoslo.web.id');
    });

    it('should strip explicit :443 port suffix', () => {
      expect(normalizeHost('api.priaoslo.web.id:443')).toBe('api.priaoslo.web.id');
    });

    it('should strip other port suffixes', () => {
      expect(normalizeHost('api.priaoslo.web.id:20128')).toBe('api.priaoslo.web.id');
      expect(normalizeHost('localhost:3000')).toBe('localhost');
    });

    it('should handle IPv6 literals safely (not misclassify)', () => {
      expect(normalizeHost('[::1]:20128')).toBe('::1');
      expect(normalizeHost('[::1]')).toBe('::1');
      expect(normalizeHost('[2001:db8::1]:443')).toBe('2001:db8::1');
    });

    it('should handle IPv6 without brackets', () => {
      expect(normalizeHost('::1')).toBe('::1');
    });

    it('should handle regular IPv4', () => {
      expect(normalizeHost('192.168.1.1')).toBe('192.168.1.1');
      expect(normalizeHost('192.168.1.1:8080')).toBe('192.168.1.1');
    });
  });

  describe('isBansosHost', () => {
    it('should return true for the bansos host (exact match after normalization)', () => {
      expect(isBansosHost('api.priaoslo.web.id')).toBe(true);
      expect(isBansosHost('API.PRIAOSLO.WEB.ID')).toBe(true);
      expect(isBansosHost('Api.PrIaOsLo.Web.Id')).toBe(true);
    });

    it('should return true when bansos host has explicit :443 port', () => {
      expect(isBansosHost('api.priaoslo.web.id:443')).toBe(true);
    });

    it('should return false for bansos host with non-standard port', () => {
      expect(isBansosHost('api.priaoslo.web.id:20128')).toBe(false);
      expect(isBansosHost('api.priaoslo.web.id:8080')).toBe(false);
    });

    it('should return false for different hosts', () => {
      expect(isBansosHost('localhost')).toBe(false);
      expect(isBansosHost('example.com')).toBe(false);
      expect(isBansosHost('api.example.com')).toBe(false);
    });

    it('should return false for IPv6 literals (not the bansos host)', () => {
      expect(isBansosHost('[::1]')).toBe(false);
      expect(isBansosHost('[::1]:20128')).toBe(false);
    });

    it('should return false for IPv4 literals (not the bansos host)', () => {
      expect(isBansosHost('192.168.1.1')).toBe(false);
    });

    it('should only check Host header, not X-Forwarded-Host', () => {
      // This test documents that the function takes only the Host header value,
      // and does not look at X-Forwarded-Host. The function signature does not
      // take X-Forwarded-Host as a parameter, so this is guaranteed.
      expect(isBansosHost('some-other-host')).toBe(false);
    });
  });

  describe('isAllowedBansosEndpoint', () => {
    describe('public form (/v1/*)', () => {
      it('should return true for GET /v1/models', () => {
        expect(isAllowedBansosEndpoint('GET', '/v1/models')).toBe(true);
      });

      it('should return true for POST /v1/chat/completions', () => {
        expect(isAllowedBansosEndpoint('POST', '/v1/chat/completions')).toBe(true);
      });
    });

    describe('rewritten form (/api/v1/*)', () => {
      it('should return true for GET /api/v1/models', () => {
        expect(isAllowedBansosEndpoint('GET', '/api/v1/models')).toBe(true);
      });

      it('should return true for POST /api/v1/chat/completions', () => {
        expect(isAllowedBansosEndpoint('POST', '/api/v1/chat/completions')).toBe(true);
      });
    });

    describe('denied methods', () => {
      it('should return false for unsupported HTTP methods on allowed paths', () => {
        expect(isAllowedBansosEndpoint('DELETE', '/v1/models')).toBe(false);
        expect(isAllowedBansosEndpoint('PUT', '/v1/models')).toBe(false);
        expect(isAllowedBansosEndpoint('PATCH', '/v1/chat/completions')).toBe(false);
        expect(isAllowedBansosEndpoint('HEAD', '/v1/chat/completions')).toBe(false);
      });
    });

    describe('denied endpoints', () => {
      it('should return false for non-allowlisted endpoints', () => {
        expect(isAllowedBansosEndpoint('GET', '/v1/responses')).toBe(false);
        expect(isAllowedBansosEndpoint('GET', '/v1/embeddings')).toBe(false);
        expect(isAllowedBansosEndpoint('POST', '/v1/embeddings')).toBe(false);
        expect(isAllowedBansosEndpoint('GET', '/v1/audio/speech')).toBe(false);
        expect(isAllowedBansosEndpoint('POST', '/v1/files')).toBe(false);
      });

      it('should return false for non-allowlisted endpoints (rewritten form)', () => {
        expect(isAllowedBansosEndpoint('GET', '/api/v1/responses')).toBe(false);
        expect(isAllowedBansosEndpoint('GET', '/api/v1/embeddings')).toBe(false);
        expect(isAllowedBansosEndpoint('POST', '/api/v1/embeddings')).toBe(false);
      });

      it('should return false for paths outside /v1', () => {
        expect(isAllowedBansosEndpoint('GET', '/dashboard')).toBe(false);
        expect(isAllowedBansosEndpoint('POST', '/login')).toBe(false);
        expect(isAllowedBansosEndpoint('GET', '/api/auth')).toBe(false);
      });
    });

    describe('case sensitivity', () => {
      it('should handle uppercase methods', () => {
        expect(isAllowedBansosEndpoint('GET', '/v1/models')).toBe(true);
        expect(isAllowedBansosEndpoint('POST', '/v1/chat/completions')).toBe(true);
      });

      it('should return false for lowercase method names', () => {
        expect(isAllowedBansosEndpoint('get', '/v1/models')).toBe(false);
        expect(isAllowedBansosEndpoint('post', '/v1/chat/completions')).toBe(false);
      });
    });
  });

  describe('validateBansosModel', () => {
    it('should return true for exact PUBLIC_MODEL match', () => {
      expect(validateBansosModel('bansos/grok-4.5')).toBe(true);
    });

    it('should return false for different models', () => {
      expect(validateBansosModel('gpt-4')).toBe(false);
      expect(validateBansosModel('claude-3-opus')).toBe(false);
      expect(validateBansosModel('gcli/grok-4.5')).toBe(false); // INTERNAL_MODEL
    });

    it('should return false for case variants', () => {
      expect(validateBansosModel('BANSOS/GROK-4.5')).toBe(false);
      expect(validateBansosModel('Bansos/Grok-4.5')).toBe(false);
      expect(validateBansosModel('bansos/GROK-4.5')).toBe(false);
    });

    it('should return false for whitespace variants', () => {
      expect(validateBansosModel(' bansos/grok-4.5')).toBe(false);
      expect(validateBansosModel('bansos/grok-4.5 ')).toBe(false);
      expect(validateBansosModel('bansos / grok-4.5')).toBe(false);
    });

    it('should return false for partial matches', () => {
      expect(validateBansosModel('bansos/grok')).toBe(false);
      expect(validateBansosModel('grok-4.5')).toBe(false);
      expect(validateBansosModel('bansos/grok-4.5-extra')).toBe(false);
    });
  });

  describe('bansosError', () => {
    it('should produce OpenAI-compatible error envelope', () => {
      const error = bansosError(400, 'Invalid request', 'invalid_request_error', 'invalid_format');
      expect(error.status).toBe(400);
      expect(error.body).toEqual({
        error: {
          message: 'Invalid request',
          type: 'invalid_request_error',
          code: 'invalid_format',
        },
      });
    });

    it('should return status code as provided', () => {
      expect(bansosError(401, 'Unauthorized', 'auth_error', 'invalid_api_key').status).toBe(401);
      expect(bansosError(403, 'Forbidden', 'permission_error', 'access_denied').status).toBe(403);
      expect(bansosError(404, 'Not found', 'invalid_request_error', 'endpoint_not_found').status).toBe(404);
      expect(bansosError(413, 'Payload too large', 'invalid_request_error', 'request_too_large').status).toBe(413);
      expect(bansosError(429, 'Rate limited', 'rate_limit_error', 'concurrency_limit_exceeded').status).toBe(429);
    });

    it('should include extra headers in the returned object', () => {
      const error = bansosError(
        429,
        'Concurrent request limit exceeded',
        'rate_limit_error',
        'concurrency_limit_exceeded',
        { 'Retry-After': '60', 'X-RateLimit-Limit': '100' }
      );
      expect(error.status).toBe(429);
      expect(error.headers).toEqual({
        'Retry-After': '60',
        'X-RateLimit-Limit': '100',
      });
    });

    it('should handle missing extraHeaders gracefully', () => {
      const error = bansosError(400, 'Bad request', 'invalid_request_error', 'malformed');
      expect(error.status).toBe(400);
      expect(error.headers).toBeUndefined();
    });

    it('should return headers as empty object if extraHeaders provided but empty', () => {
      const error = bansosError(400, 'Bad request', 'invalid_request_error', 'malformed', {});
      expect(error.status).toBe(400);
      expect(error.headers).toEqual({});
    });

    it('should preserve all error envelope fields', () => {
      const error = bansosError(
        429,
        'Concurrent request limit exceeded',
        'rate_limit_error',
        'concurrency_limit_exceeded'
      );
      expect(error.body.error.message).toBe('Concurrent request limit exceeded');
      expect(error.body.error.type).toBe('rate_limit_error');
      expect(error.body.error.code).toBe('concurrency_limit_exceeded');
    });
  });
});
