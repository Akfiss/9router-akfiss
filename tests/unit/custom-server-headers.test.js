import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'http';

let wrappedHandler;
let originalCreateServer;

// Set up mock before custom-server is imported
originalCreateServer = http.createServer;
http.createServer = vi.fn(function(...args) {
  const handler = args.find((a) => typeof a === 'function');
  if (handler) {
    wrappedHandler = handler;
  }
  return {
    once: vi.fn(function() {
      return this;
    }),
    emit: originalCreateServer().emit,
    listen: vi.fn(),
  };
});

// Import custom-server after mock is in place
await import('../../custom-server.js');

describe('custom-server headers - x-forwarded-host stripping', () => {
  beforeEach(() => {
    // Reset wrapper for each test
    wrappedHandler = null;
    // Call the new http.createServer to capture the wrapped handler
    const dummyHandler = vi.fn();
    http.createServer(dummyHandler);
  });

  it('should remove x-forwarded-host from client requests (direct socket)', () => {
    // Verify we captured the wrapped handler
    expect(wrappedHandler).toBeDefined();

    // Create a test request from a direct client (public IP)
    const req = {
      socket: {
        remoteAddress: '203.0.113.1',
      },
      headers: {
        host: 'example.com',
        'x-forwarded-host': 'malicious.com',
      },
    };

    const res = {};

    // Call the wrapped handler
    wrappedHandler(req, res);

    // Assert: host should survive
    expect(req.headers.host).toBe('example.com');
    // Assert: x-forwarded-host should be deleted
    expect(req.headers['x-forwarded-host']).toBeUndefined();
    // Assert: x-9r-real-ip should be set from socket
    expect(req.headers['x-9r-real-ip']).toBe('203.0.113.1');
    // Assert: for a direct socket with no XFF/XRI, x-9r-via-proxy should not be set
    expect(req.headers['x-9r-via-proxy']).toBeUndefined();
  });

  it('should remove x-forwarded-host even when loopback proxy sets it (with x-real-ip)', () => {
    expect(wrappedHandler).toBeDefined();

    // Create a test request from a loopback reverse proxy that included forwarding headers
    const req = {
      socket: {
        remoteAddress: '127.0.0.1',
      },
      headers: {
        host: 'example.com',
        'x-forwarded-host': 'malicious.com',
        'x-real-ip': '10.0.0.5', // The actual client IP from the proxy
      },
    };

    const res = {};

    wrappedHandler(req, res);

    // Assert: host should survive
    expect(req.headers.host).toBe('example.com');
    // Assert: x-forwarded-host should be deleted
    expect(req.headers['x-forwarded-host']).toBeUndefined();
    // Assert: x-9r-real-ip should be set to the proxied IP (since it's from loopback)
    expect(req.headers['x-9r-real-ip']).toBe('10.0.0.5');
    // Assert: x-9r-via-proxy should be set because we had forwarding headers
    expect(req.headers['x-9r-via-proxy']).toBe('1');
  });

  it('should remove x-forwarded-host even with x-forwarded-for from loopback proxy', () => {
    expect(wrappedHandler).toBeDefined();

    // Create a test request from a loopback proxy using x-forwarded-for
    const req = {
      socket: {
        remoteAddress: '127.0.0.1',
      },
      headers: {
        host: 'example.com',
        'x-forwarded-host': 'attacker.com',
        'x-forwarded-for': '192.0.2.1, 10.0.0.5',
      },
    };

    const res = {};

    wrappedHandler(req, res);

    // Assert: host should survive
    expect(req.headers.host).toBe('example.com');
    // Assert: x-forwarded-host should be deleted
    expect(req.headers['x-forwarded-host']).toBeUndefined();
    // Assert: x-9r-real-ip should use the first IP from XFF (since from loopback proxy)
    expect(req.headers['x-9r-real-ip']).toBe('192.0.2.1');
    // Assert: x-9r-via-proxy should be set
    expect(req.headers['x-9r-via-proxy']).toBe('1');
    // Assert: original forwarding headers cleaned up
    expect(req.headers['x-forwarded-for']).toBeUndefined();
  });

  it('should ignore x-forwarded-host spoofing attempts from public IPs', () => {
    expect(wrappedHandler).toBeDefined();

    // Attacker on public IP trying to spoof via forwarding headers
    const req = {
      socket: {
        remoteAddress: '203.0.113.42',
      },
      headers: {
        host: 'example.com',
        'x-forwarded-host': 'trusted.internal.com',
        'x-forwarded-for': '192.0.2.100', // Fake internal IP
        'x-real-ip': '10.0.0.1', // Fake internal IP
      },
    };

    const res = {};

    wrappedHandler(req, res);

    // Assert: host should survive
    expect(req.headers.host).toBe('example.com');
    // Assert: x-forwarded-host should be deleted
    expect(req.headers['x-forwarded-host']).toBeUndefined();
    // Assert: x-9r-real-ip should use the actual socket IP (ignore fake headers)
    expect(req.headers['x-9r-real-ip']).toBe('203.0.113.42');
    // Assert: x-forwarded-for should be stripped (existing behavior)
    expect(req.headers['x-forwarded-for']).toBeUndefined();
  });
});
