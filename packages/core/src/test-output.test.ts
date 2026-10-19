import { describe, expect, it } from 'vitest';
import { parseJunitXml, parseTestOutput } from './test-output.js';

describe('parseTestOutput', () => {
  it('parses pytest summaries in any order', () => {
    expect(
      parseTestOutput('...\n========= 2 failed, 10 passed, 1 skipped in 0.12s =========\n'),
    ).toEqual({
      runner: 'pytest',
      passed: 10,
      failed: 2,
      skipped: 1,
    });
    expect(parseTestOutput('=== 142 passed in 3.21s ===')).toMatchObject({
      passed: 142,
      failed: 0,
    });
    expect(parseTestOutput('=== 1 error in 0.1s ===')).toMatchObject({ passed: 0, failed: 1 });
  });

  it('parses unittest', () => {
    expect(parseTestOutput('test_a ... ok\n\nRan 3 tests in 0.001s\n\nOK\n')).toEqual({
      runner: 'unittest',
      passed: 3,
      failed: 0,
      skipped: 0,
    });
    expect(parseTestOutput('Ran 5 tests in 0.2s\n\nFAILED (failures=1, errors=1)\n')).toEqual({
      runner: 'unittest',
      passed: 3,
      failed: 2,
      skipped: 0,
    });
    expect(parseTestOutput('Ran 4 tests in 0.2s\n\nOK (skipped=1)\n')).toMatchObject({
      passed: 3,
      skipped: 1,
    });
  });

  it('parses jest and vitest', () => {
    expect(parseTestOutput('Tests:       1 failed, 2 skipped, 145 passed, 148 total\n')).toEqual({
      runner: 'jest',
      passed: 145,
      failed: 1,
      skipped: 2,
    });
    expect(
      parseTestOutput(' RUN  v3.2.7\n Test Files  8 passed (8)\n      Tests  37 passed (37)\n'),
    ).toEqual({
      runner: 'vitest',
      passed: 37,
      failed: 0,
      skipped: 0,
    });
  });

  it('parses go test with and without -v', () => {
    expect(
      parseTestOutput(
        '=== RUN TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n--- SKIP: TestC\nFAIL\n',
      ),
    ).toEqual({
      runner: 'go',
      passed: 1,
      failed: 1,
      skipped: 1,
    });
    expect(parseTestOutput('ok  \texample.com/a\t0.012s\nFAIL\texample.com/b\t0.3s\n')).toEqual({
      runner: 'go',
      passed: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it('sums cargo test results across binaries', () => {
    const out =
      'test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\n' +
      'test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\n';
    expect(parseTestOutput(out)).toEqual({ runner: 'cargo', passed: 15, failed: 1, skipped: 1 });
  });

  it('returns null for unknown output', () => {
    expect(parseTestOutput('make: *** [test] Error 1')).toBeNull();
  });
});

describe('parseJunitXml', () => {
  it('uses the testsuites root totals when present', () => {
    expect(
      parseJunitXml(
        '<testsuites tests="10" failures="1" errors="1" skipped="2"><testsuite/></testsuites>',
      ),
    ).toEqual({
      runner: 'junit',
      passed: 6,
      failed: 2,
      skipped: 2,
    });
  });

  it('sums suites otherwise', () => {
    const xml =
      '<testsuite name="a" tests="3" failures="0"></testsuite><testsuite name="b" tests="2" failures="1" skipped="1"></testsuite>';
    expect(parseJunitXml(xml)).toEqual({ runner: 'junit', passed: 3, failed: 1, skipped: 1 });
    expect(parseJunitXml('<nothing/>')).toBeNull();
  });
});
