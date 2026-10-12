import { AppError } from '@isnanme/core';
import type { ChatFile } from '@portal/contracts';
import { PortalToolError, portalTools, z, type ToolRegistry } from '../../portalmcp/registry.js';
import { formatBytes } from './format.js';

// The chat content tool for the Portal MCP (interface I2, chat-sessions PRD FR32): the agent hands a file to the person
// on purpose. It shows up in the chat as an artifact card (preview, Download), where the agent's reply is. Bound to the
// session its per-session token (I8) was minted for; the same copy-out rules as every other artifact (FR33): only regular
// files under the workspace's home folder, never the portal's or Claude Code's own folders, checked on the opened file.

/** What the tool needs of the chat controller. */
export interface ArtifactToolHost {
  publishArtifact(sessionId: string, path: string, name?: string): Promise<ChatFile>;
}

export function registerArtifactTools(chat: ArtifactToolHost, registry: ToolRegistry = portalTools): void {
  registry.register({
    name: 'artifact_publish',
    title: 'Hand a file to the person',
    description:
      'Shows a file from the workspace in the chat as a card the person can preview and download: a report, a chart, a document, a recording. The file is copied when you call this; later changes to it are not. Up to 25 MB, under the home folder only. Text copies have secrets removed.',
    scope: 'agent',
    hints: { idempotent: false },
    rate: { perMinute: 20, perHour: 200 },
    maxArgsBytes: 4_096,
    input: z.object({
      path: z.string().min(1).max(1024).describe('Absolute path of the file in the workspace, for example /home/node/project/report.pdf.'),
      name: z.string().max(120).optional().describe('The name to show and download as. Default: the file’s own name.'),
    }),
    async handler(ctx, { path, name }) {
      // An agent is known by its token: it can hand over a file only in the chat it is. An admin's token has no chat of its own.
      if (!ctx.sessionId) throw new PortalToolError('SESSION_REQUIRED', 'Only a chat session can hand over a file: this token isn’t one.');
      try {
        const file = await chat.publishArtifact(ctx.sessionId, path, name);
        ctx.affected(`session:${ctx.sessionId}`);
        return { summary: `Showed ${file.name} (${formatBytes(file.size)}) in the chat.`, artifact: { name: file.name, size: file.size, mediaType: file.mediaType, preview: file.preview } };
      } catch (e) {
        if (e instanceof AppError && e.expose) throw new PortalToolError(e.code, e.message);
        throw e;
      }
    },
  });
}
