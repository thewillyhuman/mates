/**
 * Parsers for the canonical `test` command's output (§7.3 step 6, decision
 * 0012). Each parser looks at the summary lines of a known framework and
 * returns counts; the first that matches wins. Unknown output → null.
 */
export interface TestSummary {
  runner: string;
  passed: number;
  failed: number;
  skipped: number;
}

type Parser = (text: string) => TestSummary | null;

const pytest: Parser = (text) => {
  const line = [...text.matchAll(/^=+ (.+?) in [\d.]+s(?: \([^)]*\))? =+$/gm)].at(-1);
  if (!line) return null;
  const counts: Record<string, number> = {};
  for (const m of line[1]!.matchAll(
    /(\d+) (passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)/g,
  )) {
    counts[m[2]!] = Number(m[1]);
  }
  if (!(
    'passed' in counts ||
    'failed' in counts ||
    'skipped' in counts ||
    'error' in counts ||
    'errors' in counts
  )) {
    return null;
  }
  return {
    runner: 'pytest',
    passed: counts.passed ?? 0,
    failed: (counts.failed ?? 0) + (counts.error ?? 0) + (counts.errors ?? 0),
    skipped: counts.skipped ?? 0,
  };
};

const unittest: Parser = (text) => {
  const ran = /^Ran (\d+) tests? in [\d.]+s$/m.exec(text);
  if (!ran) return null;
  const total = Number(ran[1]);
  const tail = text.slice(ran.index);
  const ok = /^OK(?: \((.*)\))?$/m.exec(tail);
  const failed = /^FAILED \((.*)\)$/m.exec(tail);
  const detail = (ok?.[1] ?? failed?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reduce<Record<string, number>>((acc, kv) => {
      const [k, v] = kv.split('=');
      if (k && v) acc[k] = Number(v);
      return acc;
    }, {});
  const skipped = detail.skipped ?? 0;
  const failures = (detail.failures ?? 0) + (detail.errors ?? 0);
  return { runner: 'unittest', passed: total - skipped - failures, failed: failures, skipped };
};

const jestLike: Parser = (text) => {
  const line = [...text.matchAll(/^\s*Tests:?\s+(.+)$/gm)].at(-1);
  if (!line) return null;
  const counts: Record<string, number> = {};
  for (const m of line[1]!.matchAll(/(\d+) (passed|failed|skipped|todo|pending)/g))
    counts[m[2]!] = Number(m[1]);
  if (!('passed' in counts || 'failed' in counts)) return null;
  return {
    // jest prints "… 148 total"; vitest prints "… (148)".
    runner: /\d+ total/.test(line[1]!) ? 'jest' : 'vitest',
    passed: counts.passed ?? 0,
    failed: counts.failed ?? 0,
    skipped: (counts.skipped ?? 0) + (counts.todo ?? 0) + (counts.pending ?? 0),
  };
};

const goTest: Parser = (text) => {
  const pass = (text.match(/^\s*--- PASS:/gm) ?? []).length;
  const fail = (text.match(/^\s*--- FAIL:/gm) ?? []).length;
  const skip = (text.match(/^\s*--- SKIP:/gm) ?? []).length;
  if (pass + fail + skip > 0) return { runner: 'go', passed: pass, failed: fail, skipped: skip };
  const okPkgs = (text.match(/^ok\s+\S+/gm) ?? []).length;
  const failPkgs = (text.match(/^FAIL\s+\S+/gm) ?? []).length;
  if (okPkgs + failPkgs === 0) return null;
  return { runner: 'go', passed: okPkgs, failed: failPkgs, skipped: 0 };
};

const cargo: Parser = (text) => {
  const results = [
    ...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm),
  ];
  if (results.length === 0) return null;
  return results.reduce(
    (acc, m) => ({
      runner: 'cargo',
      passed: acc.passed + Number(m[1]),
      failed: acc.failed + Number(m[2]),
      skipped: acc.skipped + Number(m[3]),
    }),
    { runner: 'cargo', passed: 0, failed: 0, skipped: 0 },
  );
};

/** JUnit XML: sums every `<testsuite>` (or the `<testsuites>` root when it carries totals). */
export function parseJunitXml(xml: string): TestSummary | null {
  const attr = (tag: string, name: string): number | null => {
    const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="(\\d+)"`).exec(xml);
    return m ? Number(m[1]) : null;
  };
  const rootTests = attr('testsuites', 'tests');
  if (rootTests !== null) {
    const failed = (attr('testsuites', 'failures') ?? 0) + (attr('testsuites', 'errors') ?? 0);
    const skipped = attr('testsuites', 'skipped') ?? 0;
    return { runner: 'junit', passed: rootTests - failed - skipped, failed, skipped };
  }
  const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)];
  if (suites.length === 0) return null;
  let tests = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of suites) {
    const a = s[1]!;
    const n = (name: string) => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(a)?.[1] ?? 0);
    tests += n('tests');
    failed += n('failures') + n('errors');
    skipped += n('skipped');
  }
  return { runner: 'junit', passed: tests - failed - skipped, failed, skipped };
}

const PARSERS: readonly Parser[] = [pytest, unittest, jestLike, cargo, goTest];

/** Parses test output; `null` when no known framework summary is found. */
export function parseTestOutput(text: string): TestSummary | null {
  for (const p of PARSERS) {
    const r = p(text);
    if (r) return r;
  }
  return null;
}
