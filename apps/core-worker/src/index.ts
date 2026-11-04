import { createApp } from './app.js';
import type { Env } from './env.js';

export { BridgeDO, ChatSessionDO, OrgDO, PlatformDO, WorkspaceDO } from './do/index.js';

const app = createApp();

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
