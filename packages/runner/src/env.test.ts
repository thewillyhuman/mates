import { describe, expect, it } from 'vitest';
import { parseRunnerEnv } from './env.js';

const full = {
  MATES_API_URL: 'http://mates-api:8080',
  MATES_INVOCATION_TOKEN: 'jwt',
  MATES_INVOCATION_ID: 'inv-1',
  MATES_RUN_ID: 'run-1',
  MATES_MATE: 'implementer',
  MATES_ITERATION: '2',
};

describe('parseRunnerEnv', () => {
  it('parses the variables the job spec sets (§7.2)', () => {
    const env = parseRunnerEnv(full);
    expect(env.apiUrl).toBe('http://mates-api:8080');
    expect(env.mate).toBe('implementer');
    expect(env.iteration).toBe(2);
    expect(env.fakeClaude).toBe(false);
  });

  it('rejects an unknown mate', () => {
    expect(() => parseRunnerEnv({ ...full, MATES_MATE: 'janitor' })).toThrow(/MATES_MATE/);
  });

  it('lists every missing variable at once', () => {
    expect(() => parseRunnerEnv({})).toThrow(/MATES_API_URL.*MATES_INVOCATION_TOKEN/s);
  });

  it('enables fake Claude from MATES_FAKE_CLAUDE=1', () => {
    expect(parseRunnerEnv({ ...full, MATES_FAKE_CLAUDE: '1' }).fakeClaude).toBe(true);
  });
});
