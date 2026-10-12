import type { McpBuiltinTemplate } from '@portal/contracts';
import { cloudflare } from './cloudflare.js';
import { gitea } from './gitea.js';
import { github } from './github.js';
import { gitlab } from './gitlab.js';
import { outline } from './outline.js';

/**
 * The built-in templates, in the order the catalogue's shelf shows them (providers PRD). The registry (`../registry.ts`) validates
 * every one when the server starts; each file explains its provider's choices. A change to a definition bumps its `version`
 * and `checkedAt`, so instances show "Update".
 */
export const BUILTIN_TEMPLATES: readonly McpBuiltinTemplate[] = [github, gitlab, gitea, outline, cloudflare];
