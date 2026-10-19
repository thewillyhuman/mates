import { branchMatchesPattern } from '@mates/core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git operations for the workspace (§7.3 steps 2 and 6, §10.5).
 *
 * Credentials come from a helper that reads GIT_USERNAME/GIT_TOKEN from the
 * environment, so the token never appears in a URL, in `git remote -v`, in
 * commits or in logs.
 */
export interface GitOptions {
  cwd: string;
  username: string;
  token: string | undefined;
  authorName: string;
  authorEmail: string;
}

export interface DiffStat {
  files_changed: number;
  additions: number;
  deletions: number;
}

export class PushRefusedError extends Error {}

const CREDENTIAL_HELPER = '!f() { echo "username=$GIT_USERNAME"; echo "password=$GIT_TOKEN"; }; f';

export class Git {
  constructor(private readonly opts: GitOptions) {}

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_USERNAME: this.opts.username,
      GIT_TOKEN: this.opts.token ?? '',
      GIT_AUTHOR_NAME: this.opts.authorName,
      GIT_AUTHOR_EMAIL: this.opts.authorEmail,
      GIT_COMMITTER_NAME: this.opts.authorName,
      GIT_COMMITTER_EMAIL: this.opts.authorEmail,
    };
  }

  async run(args: string[], cwd = this.opts.cwd): Promise<string> {
    const full = ['-c', `credential.helper=${CREDENTIAL_HELPER}`, ...args];
    try {
      const { stdout } = await execFileAsync('git', full, {
        cwd,
        env: this.env(),
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error(`git ${args[0]} failed: ${(e.stderr ?? e.message).trim().slice(0, 2000)}`);
    }
  }

  /** `git clone --depth 50 --branch <base>` into the workspace directory. */
  async clone(cloneUrl: string, baseBranch: string): Promise<void> {
    await this.run(
      ['clone', '--depth', '50', '--branch', baseBranch, '--', cloneUrl, this.opts.cwd],
      process.cwd(),
    );
  }

  /**
   * Checks out the run branch: tracking the remote one when it exists
   * (iteration > 1, reviewer), otherwise a new branch from the base.
   */
  async checkoutRunBranch(branch: string, baseBranch: string): Promise<'existing' | 'new'> {
    const remote = await this.run(['ls-remote', '--heads', 'origin', branch]);
    if (remote.trim()) {
      await this.run([
        'fetch',
        '--depth',
        '50',
        'origin',
        `${branch}:refs/remotes/origin/${branch}`,
      ]);
      await this.run(['checkout', '-B', branch, `origin/${branch}`]);
      return 'existing';
    }
    await this.run(['checkout', '-B', branch, `origin/${baseBranch}`]);
    return 'new';
  }

  /** Makes sure the base branch tip is available locally for diffs. */
  async fetchBase(baseBranch: string): Promise<void> {
    await this.run([
      'fetch',
      '--depth',
      '50',
      'origin',
      `${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ]);
  }

  async headSha(): Promise<string> {
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return (await this.run(['status', '--porcelain'])).trim().length > 0;
  }

  /** Stages everything and commits; returns the new sha, or null when there was nothing to commit. */
  async commitAll(message: string): Promise<string | null> {
    await this.run(['add', '-A']);
    if (!(await this.hasUncommittedChanges())) return null;
    // `-F -` reads the message from stdin, so this call cannot go through run().
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'git',
        ['-c', `credential.helper=${CREDENTIAL_HELPER}`, 'commit', '--quiet', '-F', '-'],
        { cwd: this.opts.cwd, env: this.env() },
        (err, _stdout, stderr) =>
          err ? reject(new Error(`git commit failed: ${stderr}`)) : resolve(),
      );
      child.stdin?.end(message);
    });
    return this.headSha();
  }

  async diffStat(fromRef: string, toRef = 'HEAD'): Promise<DiffStat> {
    const out = await this.run(['diff', '--shortstat', `${fromRef}..${toRef}`]);
    const files = /(\d+) files? changed/.exec(out);
    const add = /(\d+) insertions?\(\+\)/.exec(out);
    const del = /(\d+) deletions?\(-\)/.exec(out);
    return {
      files_changed: Number(files?.[1] ?? 0),
      additions: Number(add?.[1] ?? 0),
      deletions: Number(del?.[1] ?? 0),
    };
  }

  async diff(fromRef: string, toRef = 'HEAD'): Promise<string> {
    return this.run(['diff', `${fromRef}..${toRef}`]);
  }

  /**
   * Pushes HEAD to `branch` with --force-with-lease. Refuses the default
   * branch and anything the branching pattern could not have produced.
   */
  async push(branch: string, pattern: string, defaultBranch: string): Promise<void> {
    if (branch === defaultBranch || !branchMatchesPattern(branch, pattern)) {
      throw new PushRefusedError(`refusing to push to "${branch}": not a ${pattern} branch`);
    }
    await this.run(['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`]);
  }

  /** Applies a patch file (fake mode); `git apply` fails loudly on a mismatch. */
  async applyPatch(patchFile: string): Promise<void> {
    await this.run(['apply', '--whitespace=nowarn', patchFile]);
  }
}
