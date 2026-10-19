import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const minimal = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/mates',
  MATES_INTERNAL_KEY: 'k'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const cfg = loadConfig(minimal);
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.release).toBe('mates');
    expect(cfg.namespace).toBe('mates');
    expect(cfg.publicUrl).toBe('http://localhost:8080');
    expect(cfg.secretStore).toBe('memory');
  });

  it('rejects a missing database url', () => {
    expect(() => loadConfig({ MATES_INTERNAL_KEY: 'k'.repeat(32) })).toThrow(/DATABASE_URL/);
  });

  it('rejects a short internal key', () => {
    expect(() => loadConfig({ ...minimal, MATES_INTERNAL_KEY: 'short' })).toThrow(
      /MATES_INTERNAL_KEY/,
    );
  });

  it('selects the kubernetes secret store when running in-cluster', () => {
    const cfg = loadConfig({ ...minimal, KUBERNETES_SERVICE_HOST: '10.0.0.1' });
    expect(cfg.secretStore).toBe('kubernetes');
  });

  it('strips a trailing slash from the public url', () => {
    const cfg = loadConfig({ ...minimal, MATES_PUBLIC_URL: 'https://mates.example.com/' });
    expect(cfg.publicUrl).toBe('https://mates.example.com');
  });
});
