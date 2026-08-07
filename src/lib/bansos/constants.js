/**
 * Bansos Gateway - Public host policy constants
 * Immutable configuration for the public API endpoint.
 */

export const BANSOS_HOST = 'api.priaoslo.web.id';
export const PUBLIC_MODEL = 'bansos/grok-4.5';
export const INTERNAL_MODEL = 'gcli/grok-4.5';

/**
 * Bansos Gateway limits and constraints
 */
export const BANSOS_LIMITS = {
  // Maximum request body size: 2 MiB
  maxRequestBody: 2 * 1024 * 1024,

  // First response timeout: 60 seconds
  firstResponseTimeoutMs: 60 * 1000,

  // Maximum stream duration: 10 minutes
  maxStreamDurationMs: 10 * 60 * 1000,

  // Maximum prompt size: 64 KiB
  maxPromptSize: 64 * 1024,

  // Prompt retention period: 7 days
  promptRetentionDays: 7,
};
