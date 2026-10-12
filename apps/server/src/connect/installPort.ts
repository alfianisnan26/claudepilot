// What Connect needs from the installers' package (T4, connect/install/): its agent-facing routes, the commands the wizard shows and the plan
// preview. One small interface so the control plane's tests can run with a stand-in, and the portal wires the real thing in one line.

import type { Hono } from 'hono';
import type { ConnectCommands, ConnectEnrollment, ConnectInstallOptions, ConnectPlanPreview } from '@portal/contracts';
import { buildCommands, previewSteps, type CommandsInput } from './install/commands.js';
import { buildManifest } from './install/manifest.js';
import { buildPlan, type PlanInput } from './install/plan.js';
import { createInstallRoutes, declareInstallPolicies, installerDigests, workspaceContextTgz } from './install/routes.js';
import type { ConnectTargetRecord, InstallDeps } from './seams.js';

export interface InstallPort {
  /** The agent-facing routes (`/connect/install.sh`, `/connect/v1/plan`, ...), with full paths: mounted at the root. */
  routes(deps: InstallDeps, opts: { limiter: { blocked(ip: string): boolean; fail(ip: string): void }; clientIp(c: { req: { header(name: string): string | undefined }; env?: unknown }): string }): Hono;
  /** The commands for one token (`ConnectEnrollmentCreated.commands`). */
  commands(input: Omit<CommandsInput, 'sha256'>): ConnectCommands;
  /** The steps the installer will take for an enrollment, and for Kubernetes the manifest with the token replaced (`ConnectPlanPreview`). */
  preview(input: { enrollment: ConnectEnrollment; target: ConnectTargetRecord; options: ConnectInstallOptions; bundle: InstallDeps['bundle']; config: InstallDeps['config'] }): ConnectPlanPreview;
  /** The workspace image's build context as a tar.gz stream (`InstallDeps.workspaceContext`). */
  workspaceContext(): NodeJS.ReadableStream;
  /** Declares the routes' access policies (once; idempotent). */
  declarePolicies(): void;
}

/** The real installers. */
export const realInstall: InstallPort = {
  routes: (deps, opts) => createInstallRoutes(deps, opts as never) as unknown as Hono,
  commands: (input) => buildCommands({ ...input, sha256: installerDigests() }),
  preview: (input) => {
    const planInput: PlanInput = input;
    return {
      steps: previewSteps(buildPlan(planInput)),
      manifest: input.target.kind === 'kubernetes' ? buildManifest({ ...planInput, token: '<token>' }) : null,
    };
  },
  workspaceContext: () => workspaceContextTgz(),
  declarePolicies: declareInstallPolicies,
};
