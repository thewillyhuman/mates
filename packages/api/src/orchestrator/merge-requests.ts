import {
  renderMrDescription,
  renderMrTitle,
  type RunProjection,
  type TeamManifest,
} from '@mates/core';
import type { Integrations } from '../integrations.js';
import type { Logger } from '../logger.js';
import type { MergeRequest, RepoInfo, Scm } from '../scm/scm.js';
import type { Settings } from '../settings/schema.js';
import type { Ticket } from '../runs/repository.js';

/**
 * Merge request side effects (§8.3) through the Scm port: open the draft
 * once, refresh the description after every iteration, mark it ready on
 * approval. Returns nothing when no provider is configured so the loop
 * can still run (tests, evaluation without an SCM token).
 */
export interface MergeRequestsDeps {
  integrations: Integrations;
  log: Logger;
  publicUrl: string;
  version: string;
}

export interface MrTarget {
  scm: Scm;
  repo: RepoInfo;
  provider: Settings['scm']['providers'][number];
}

export class MergeRequests {
  constructor(private readonly deps: MergeRequestsDeps) {}

  /** Resolves the adapter and repository for the run's repo, if an SCM token is configured. */
  async target(
    manifest: TeamManifest,
    settings: Settings,
    repoId: string,
  ): Promise<MrTarget | undefined> {
    const repo = manifest.repos.find((r) => r.id === repoId);
    if (!repo) return undefined;
    const provider = settings.scm.providers.find((p) => p.id === repo.scm);
    const scm = await this.deps.integrations.scm(repo.scm);
    if (!provider || !scm) {
      this.deps.log.warn(
        { repo: repoId, provider: repo.scm },
        'no source-control adapter configured; skipping merge request',
      );
      return undefined;
    }
    return { scm, repo: await scm.resolveRepo(repo.project), provider };
  }

  description(
    run: { id: string },
    ticket: Ticket,
    projection: RunProjection,
    settings: Settings,
  ): string {
    return renderMrDescription({
      ticket: { key: ticket.externalKey, title: ticket.title, url: ticket.url },
      projection,
      runUrl: `${this.deps.publicUrl}/runs/${run.id}`,
      version: this.deps.version,
      models: {
        implementer: settings.mates.implementer.model,
        reviewer: settings.mates.reviewer.model,
      },
    });
  }

  async open(
    target: MrTarget,
    input: {
      run: { id: string; branch: string };
      ticket: Ticket;
      projection: RunProjection;
      baseBranch: string;
      settings: Settings;
    },
  ): Promise<MergeRequest> {
    return target.scm.openMergeRequest(target.repo, {
      source: input.run.branch,
      target: input.baseBranch,
      title: renderMrTitle(input.ticket.externalKey, input.ticket.title, target.scm.type),
      description: this.description(input.run, input.ticket, input.projection, input.settings),
      draft: target.provider.draft_mrs,
      labels: target.provider.labels,
      reviewers: target.provider.reviewers,
    });
  }

  async update(
    target: MrTarget,
    mrId: string,
    input: {
      run: { id: string };
      ticket: Ticket;
      projection: RunProjection;
      settings: Settings;
      draft?: boolean;
    },
  ): Promise<MergeRequest> {
    const patch: { description: string; draft?: boolean } = {
      description: this.description(input.run, input.ticket, input.projection, input.settings),
    };
    if (input.draft !== undefined) patch.draft = input.draft;
    return target.scm.updateMergeRequest(target.repo, mrId, patch);
  }
}
