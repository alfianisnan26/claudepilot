import {
  SKILLS_API,
  type SkillFileContent,
  type SkillImportResult,
  type SkillLibrary,
  type SkillReviewRequest,
  type SkillVersionDetail,
  type WorkspaceSkills,
} from '@portal/contracts';
import { poolRequest } from '@/features/pools/request';

/** The skill library's routes (`/api/skills`). Skillsets themselves go through the shared pool API (`api.pools`). */
export const skillsApi = {
  library: () => poolRequest<SkillLibrary>('GET', SKILLS_API.library),
  /** A zip as the raw body (Skillset FR1). */
  importZip: (file: File) =>
    poolRequest<SkillImportResult>('POST', `${SKILLS_API.import}?name=${encodeURIComponent(file.name)}`, undefined, { body: file, headers: { 'Content-Type': 'application/zip' } }),
  /** A folder as multipart: `paths` (a JSON list of relative paths) and one `files` part per path, in order. */
  importFolder: (files: { path: string; file: File }[]) => {
    const form = new FormData();
    form.set('paths', JSON.stringify(files.map((f) => f.path)));
    for (const f of files) form.append('files', f.file, f.file.name);
    return poolRequest<SkillImportResult>('POST', SKILLS_API.import, undefined, { body: form });
  },
  version: (id: string) => poolRequest<SkillVersionDetail>('GET', SKILLS_API.version(id)),
  file: (id: string, path: string, offset = 0) => poolRequest<SkillFileContent>('GET', SKILLS_API.file(id, path, offset)),
  review: (id: string, body: SkillReviewRequest) => poolRequest<SkillVersionDetail>('POST', SKILLS_API.review(id), body),
  revoke: (id: string, note: string) => poolRequest<SkillVersionDetail>('POST', SKILLS_API.revoke(id), { note }),
  removeSource: (id: string, withVersions = false) => poolRequest<{ ok: true }>('DELETE', SKILLS_API.source(id, withVersions)),
  workspace: (workspaceId: string) => poolRequest<WorkspaceSkills>('GET', SKILLS_API.workspace(workspaceId)),
  verify: (workspaceId: string) => poolRequest<WorkspaceSkills>('POST', SKILLS_API.verify(workspaceId)),
};
