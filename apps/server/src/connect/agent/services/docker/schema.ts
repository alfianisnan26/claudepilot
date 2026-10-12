// The Docker policy's body side (docs/prd/targets-connect.md §11.4, appendix A.1): a strict allowlist for what a workspace container,
// an exec and a volume may be created with. A field the schema doesn't know is a denial (`create.field`): new Docker features stay
// off until someone reviews them. What comes out is a NEW object made only of validated values, so the daemon never sees a field this
// file didn't look at (a duplicate key, a field with an odd spelling, anything the portal's JSON writer or ours might read differently).
import type { ConnectDockerRule } from '@portal/contracts';
import { LABEL } from '../../../../workspaces/runtime.js';
import { ImageAllow, VOLUME_NAME, refuse, type Refusal } from './rules.js';

export type Checked = { ok: true; body: Record<string, unknown> } | ({ ok: false } & Refusal);

const fail = (rule: ConnectDockerRule, message: string): Checked => ({ ok: false, ...refuse(rule, message) });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
const strList = (v: unknown, maxItems: number, maxEach: number): string[] | null =>
  Array.isArray(v) && v.length <= maxItems && v.every((x) => isStr(x) && x.length <= maxEach) ? (v as string[]) : null;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Nothing set: absent, null, empty, false or zero-ish containers. Such a field is dropped, not an offence. */
const emptyish = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);

const ABS_PATH = /^\/[A-Za-z0-9_@.+:=,\- /]{0,4095}$/;
const MOUNT_FORBIDDEN = ['/proc', '/sys', '/dev', '/var/run'];
const underPath = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

export interface CreateContext {
  /** The container name from the query (`claudepilot-…`). */
  name: string;
  images: ImageAllow;
  portalId: string | null;
  /** Host path prefixes the host operator allows as bind sources (`agent.json` `docker.allowBinds`); empty by default. */
  allowBinds: string[];
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * POST /containers/create
 * ---------------------------------------------------------------------------------------------------------------------------- */

const TOP_FIELDS = new Set(['Image', 'Hostname', 'User', 'WorkingDir', 'Labels', 'Env', 'Cmd', 'Entrypoint', 'Tty', 'OpenStdin', 'StopSignal', 'StopTimeout', 'HostConfig', 'name']);

export function validateCreate(raw: unknown, ctx: CreateContext): Checked {
  if (!isObj(raw)) return fail('body', 'The body must be a JSON object.');
  const out: Obj = {};

  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (key === 'ExposedPorts') {
      if (!emptyish(v)) return fail('create.port', 'Exposed ports are not allowed.');
      continue;
    }
    if (key === 'NetworkingConfig') {
      if (!emptyish(v)) return fail('create.network', 'Network settings are not allowed.');
      continue;
    }
    if (!TOP_FIELDS.has(key)) return fail('create.field', `The field ${JSON.stringify(key.slice(0, 40))} is not allowed.`);
  }

  // Image: an allowlisted reference.
  const image = raw.Image;
  if (!isStr(image) || !ctx.images.has(image)) return fail('create.image', 'That image is not allowed on this host.');
  out.Image = image;

  if (raw.name !== undefined && raw.name !== ctx.name) return fail('create.name', 'The name in the body differs from the name in the query.');

  if (raw.Hostname !== undefined) {
    if (!isStr(raw.Hostname) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(raw.Hostname)) return fail('create.field', 'Hostname is not valid.');
    out.Hostname = raw.Hostname;
  }
  if (raw.User !== undefined) {
    if (!isStr(raw.User) || !/^[A-Za-z0-9_.:-]{0,64}$/.test(raw.User)) return fail('create.field', 'User is not valid.');
    out.User = raw.User;
  }
  if (raw.WorkingDir !== undefined) {
    if (!isStr(raw.WorkingDir) || (raw.WorkingDir !== '' && !ABS_PATH.test(raw.WorkingDir))) return fail('create.field', 'WorkingDir is not valid.');
    out.WorkingDir = raw.WorkingDir;
  }
  for (const key of ['Tty', 'OpenStdin'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') return fail('create.field', `${key} must be a boolean.`);
    out[key] = raw[key];
  }
  if (raw.StopSignal !== undefined) {
    if (!isStr(raw.StopSignal) || !/^(?:SIG)?[A-Z0-9+-]{1,16}$/.test(raw.StopSignal)) return fail('create.field', 'StopSignal is not valid.');
    out.StopSignal = raw.StopSignal;
  }
  if (raw.StopTimeout !== undefined) {
    if (!isInt(raw.StopTimeout, 0, 3600)) return fail('create.field', 'StopTimeout is not valid.');
    out.StopTimeout = raw.StopTimeout;
  }
  for (const key of ['Cmd', 'Entrypoint'] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const list = strList(raw[key], 1000, 65_536);
    if (!list || list.reduce((n, s) => n + s.length, 0) > 524_288) return fail('create.field', `${key} must be a list of strings.`);
    out[key] = list;
  }
  if (raw.Env !== undefined && raw.Env !== null) {
    const env = strList(raw.Env, 1000, 65_536);
    if (!env || env.reduce((n, s) => n + s.length, 0) > 65_536 || env.some((e) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(e))) return fail('create.field', 'Env must be KEY=value strings, 64 KiB in all.');
    out.Env = env;
  }

  const labels = checkLabels(raw.Labels, ctx);
  if (!labels.ok) return labels;
  out.Labels = labels.labels;

  if (raw.HostConfig !== undefined && raw.HostConfig !== null) {
    const host = checkHostConfig(raw.HostConfig, ctx);
    if (!host.ok) return host;
    out.HostConfig = host.body;
  }
  return { ok: true, body: out };
}

function checkLabels(raw: unknown, ctx: CreateContext): { ok: true; labels: Record<string, string> } | ({ ok: false } & Refusal) {
  if (!isObj(raw)) return { ok: false, ...refuse('create.label', 'The container must carry the portal’s labels.') };
  const labels: Record<string, string> = {};
  const keys = Object.keys(raw);
  if (keys.length > 64) return { ok: false, ...refuse('create.label', 'Too many labels.') };
  for (const k of keys) {
    const v = raw[k];
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(k) || typeof v !== 'string' || v.length > 1024 || v.includes('\0')) {
      return { ok: false, ...refuse('create.label', 'A label is not valid.') };
    }
    labels[k] = v;
  }
  if ('claudepilot.connect' in labels) return { ok: false, ...refuse('create.label', 'That label is reserved for the agent.') };
  if (labels[LABEL.managed] !== 'true') return { ok: false, ...refuse('create.label', `The label ${LABEL.managed}=true is required.`) };
  if (labels[LABEL.name] !== ctx.name.slice('claudepilot-'.length)) return { ok: false, ...refuse('create.label', `The label ${LABEL.name} must be the workspace name.`) };
  if (ctx.portalId && labels[LABEL.portal] !== ctx.portalId) return { ok: false, ...refuse('create.label', `The label ${LABEL.portal} must be this portal’s id.`) };
  return { ok: true, labels };
}

/** The `HostConfig` fields a workspace needs, with the specific rule for each class of field it must never have. */
function checkHostConfig(raw: unknown, ctx: CreateContext): { ok: true; body: Obj } | ({ ok: false } & Refusal) {
  const bad = (rule: ConnectDockerRule, message: string) => ({ ok: false as const, ...refuse(rule, message) });
  if (!isObj(raw)) return bad('body', 'HostConfig must be an object.');
  const out: Obj = {};

  for (const key of Object.keys(raw)) {
    const v = raw[key];
    switch (key) {
      case 'Privileged':
        if (v !== false && v !== undefined && v !== null) return bad('create.privileged', 'Privileged containers are not allowed.');
        break;
      case 'PidMode':
      case 'IpcMode':
      case 'UTSMode':
      case 'UsernsMode':
      case 'CgroupnsMode':
      case 'Cgroup':
        if (!(v === undefined || v === null || v === '' || v === 'private')) return bad('create.namespace', 'Host namespaces are not allowed.');
        break;
      case 'Binds': {
        if (emptyish(v)) break;
        const binds = checkBinds(v, ctx.allowBinds);
        if (!binds) return bad('create.bind', 'Host mounts are not allowed.');
        out.Binds = binds;
        break;
      }
      case 'VolumesFrom':
      case 'Tmpfs':
        if (!emptyish(v)) return bad('create.bind', 'Mounts from other containers or tmpfs are not allowed.');
        break;
      case 'Devices':
      case 'DeviceCgroupRules':
      case 'DeviceRequests':
        if (!emptyish(v)) return bad('create.device', 'Devices are not allowed.');
        break;
      case 'CapAdd':
      case 'Sysctls':
      case 'Runtime':
      case 'StorageOpt':
      case 'MaskedPaths':
      case 'ReadonlyPaths':
        if (!emptyish(v)) return bad('create.capability', `${key} is not allowed.`);
        break;
      case 'SecurityOpt': {
        if (emptyish(v)) break;
        const opts = strList(v, 4, 64);
        if (!opts || opts.some((o) => !/^no-new-privileges(?:[:=]true)?$/.test(o))) return bad('create.capability', 'Only no-new-privileges may be set.');
        out.SecurityOpt = opts;
        break;
      }
      case 'PortBindings':
      case 'PublishAllPorts':
        if (!emptyish(v)) return bad('create.port', 'Publishing ports is not allowed.');
        break;
      case 'Links':
        if (!emptyish(v)) return bad('create.network', 'Container links are not allowed.');
        break;
      case 'NetworkMode':
        if (!(v === undefined || v === null || v === '' || v === 'default' || v === 'bridge')) return bad('create.network', 'Only the default network is allowed.');
        break;
      case 'RestartPolicy': {
        if (!isObj(v) || !['', 'no', 'on-failure', 'always', 'unless-stopped'].includes(v.Name as string)) return bad('create.field', 'RestartPolicy is not valid.');
        const policy: Obj = { Name: v.Name };
        if (v.MaximumRetryCount !== undefined) {
          if (!isInt(v.MaximumRetryCount, 0, 100)) return bad('create.field', 'RestartPolicy is not valid.');
          policy.MaximumRetryCount = v.MaximumRetryCount;
        }
        out.RestartPolicy = policy;
        break;
      }
      case 'Mounts': {
        if (emptyish(v)) break;
        const mounts = checkMounts(v, `${ctx.name}-home`);
        if (!mounts.ok) return mounts;
        out.Mounts = mounts.mounts;
        break;
      }
      case 'NanoCpus':
        if (!isInt(v, 0, 1e9 * 4096)) return bad('create.field', 'NanoCpus is not valid.');
        out.NanoCpus = v;
        break;
      case 'Memory':
        if (!isInt(v, 0, 2 ** 50)) return bad('create.field', 'Memory is not valid.');
        out.Memory = v;
        break;
      case 'MemorySwap':
        if (!isInt(v, -1, 2 ** 50)) return bad('create.field', 'MemorySwap is not valid.');
        out.MemorySwap = v;
        break;
      case 'CpuShares':
        if (!isInt(v, 0, 1_000_000)) return bad('create.field', 'CpuShares is not valid.');
        out.CpuShares = v;
        break;
      case 'PidsLimit':
        if (!isInt(v, -1, 1_000_000)) return bad('create.field', 'PidsLimit is not valid.');
        out.PidsLimit = v;
        break;
      case 'ShmSize':
        if (!isInt(v, 0, 1024 * 1024 * 1024)) return bad('create.field', 'ShmSize is not valid.');
        out.ShmSize = v;
        break;
      case 'AutoRemove':
      case 'Init':
        if (typeof v !== 'boolean') return bad('create.field', `${key} must be a boolean.`);
        out[key] = v;
        break;
      case 'CapDrop': {
        if (v === undefined || v === null) break;
        const caps = strList(v, 64, 40);
        if (!caps || caps.some((c) => !/^[A-Z_]{2,32}$/.test(c))) return bad('create.capability', 'CapDrop is not valid.');
        out.CapDrop = caps;
        break;
      }
      default:
        return bad('create.field', `The HostConfig field ${JSON.stringify(key.slice(0, 40))} is not allowed.`);
    }
  }
  return { ok: true, body: out };
}

function checkMounts(raw: unknown, ownVolume: string): { ok: true; mounts: Obj[] } | ({ ok: false } & Refusal) {
  const bad = (rule: ConnectDockerRule, message: string) => ({ ok: false as const, ...refuse(rule, message) });
  if (!Array.isArray(raw) || raw.length > 16) return bad('create.volume', 'Mounts must be a short list.');
  const mounts: Obj[] = [];
  for (const m of raw) {
    if (!isObj(m)) return bad('create.volume', 'A mount is not valid.');
    if (m.Type !== 'volume') return bad('create.bind', 'Only volume mounts are allowed.');
    if ('VolumeOptions' in m || 'BindOptions' in m || 'TmpfsOptions' in m) return bad('create.volume', 'Mount options are not allowed.');
    for (const key of Object.keys(m)) if (!['Type', 'Source', 'Target', 'ReadOnly'].includes(key)) return bad('create.volume', 'A mount has a field that is not allowed.');
    // The pattern is the PRD's; on top of it a workspace may mount its OWN home volume only (`claudepilot-<its name>-home`), never another workspace's.
    if (!isStr(m.Source) || !VOLUME_NAME.test(m.Source) || m.Source !== ownVolume) return bad('create.volume', 'Only a workspace’s own home volume may be mounted.');
    if (!isStr(m.Target) || !ABS_PATH.test(m.Target) || m.Target === '/' || /(^|\/)\.\.?(\/|$)/.test(m.Target) || MOUNT_FORBIDDEN.some((d) => underPath(m.Target as string, d))) {
      return bad('create.volume', 'The mount target is not allowed.');
    }
    if (m.ReadOnly !== undefined && typeof m.ReadOnly !== 'boolean') return bad('create.volume', 'A mount is not valid.');
    mounts.push({ Type: 'volume', Source: m.Source, Target: m.Target, ...(m.ReadOnly !== undefined ? { ReadOnly: m.ReadOnly } : {}) });
  }
  return { ok: true, mounts };
}

/** `Binds` entries `src:dst[:opts]`, allowed only when the host operator listed a prefix that contains `src`. Null when any entry isn't. */
function checkBinds(raw: unknown, allowed: string[]): string[] | null {
  if (!allowed.length) return null;
  const binds = strList(raw, 16, 4096);
  if (!binds) return null;
  for (const b of binds) {
    const parts = b.split(':');
    const [src, dst, opts] = parts;
    if (parts.length < 2 || parts.length > 3 || !src || !dst) return null;
    if (!src.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(src) || src.includes('//')) return null;
    if (!allowed.some((prefix) => underPath(src, prefix.replace(/\/+$/, '')))) return null;
    if (!ABS_PATH.test(dst) || dst === '/' || /(^|\/)\.\.?(\/|$)/.test(dst) || MOUNT_FORBIDDEN.some((d) => underPath(dst, d))) return null;
    if (opts !== undefined && !/^(?:ro|rw|z|Z)(?:,(?:ro|rw|z|Z))*$/.test(opts)) return null;
  }
  return binds;
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * Exec, volumes
 * ---------------------------------------------------------------------------------------------------------------------------- */

/** `POST /containers/{ref}/exec`: what `DockerRuntime` sends, and nothing that raises privileges. */
export function validateExecCreate(raw: unknown): Checked {
  if (!isObj(raw)) return fail('body', 'The body must be a JSON object.');
  const out: Obj = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    switch (key) {
      case 'Privileged':
        if (v !== false && v !== undefined && v !== null) return fail('exec.privileged', 'Privileged execs are not allowed.');
        break;
      case 'Cmd': {
        const cmd = strList(v, 1000, 65_536);
        if (!cmd || cmd.length === 0 || cmd.reduce((n, s) => n + s.length, 0) > 524_288) return fail('body', 'Cmd must be a non-empty list of strings.');
        out.Cmd = cmd;
        break;
      }
      case 'Env': {
        if (v === null) break;
        const env = strList(v, 1000, 65_536);
        if (!env || env.reduce((n, s) => n + s.length, 0) > 65_536) return fail('body', 'Env must be a list of strings.');
        out.Env = env;
        break;
      }
      case 'User':
        if (!isStr(v) || !/^[A-Za-z0-9_.:-]{0,64}$/.test(v)) return fail('body', 'User is not valid.');
        out.User = v;
        break;
      case 'WorkingDir':
        if (!isStr(v) || (v !== '' && !ABS_PATH.test(v))) return fail('body', 'WorkingDir is not valid.');
        out.WorkingDir = v;
        break;
      case 'Tty':
      case 'AttachStdin':
      case 'AttachStdout':
      case 'AttachStderr':
        if (typeof v !== 'boolean') return fail('body', `${key} must be a boolean.`);
        out[key] = v;
        break;
      case 'DetachKeys':
        if (!isStr(v) || v.length > 32) return fail('body', 'DetachKeys is not valid.');
        out.DetachKeys = v;
        break;
      default:
        return fail('body', `The exec field ${JSON.stringify(key.slice(0, 40))} is not allowed.`);
    }
  }
  if (!out.Cmd) return fail('body', 'Cmd is required.');
  return { ok: true, body: out };
}

/** `POST /exec/{id}/start`: the options Docker has, and docker-modem's own `hijack` and `stdin` (client-side switches, dropped here). */
export function validateExecStart(raw: unknown): Checked {
  if (raw === undefined || raw === null) return { ok: true, body: {} };
  if (!isObj(raw)) return fail('body', 'The body must be a JSON object.');
  const out: Obj = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    switch (key) {
      case 'Detach':
      case 'Tty':
        if (typeof v !== 'boolean') return fail('body', `${key} must be a boolean.`);
        out[key] = v;
        break;
      case 'ConsoleSize':
        if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => isInt(n, 0, 10_000))) return fail('body', 'ConsoleSize is not valid.');
        out.ConsoleSize = v;
        break;
      case 'hijack':
      case 'stdin':
        break;
      default:
        return fail('body', `The exec start field ${JSON.stringify(key.slice(0, 40))} is not allowed.`);
    }
  }
  return { ok: true, body: out };
}

/** `POST /volumes/create`: a home volume by name, with labels, on the local driver and no driver options (`o=bind` is a host mount). */
export function validateVolumeCreate(raw: unknown): Checked {
  if (!isObj(raw)) return fail('body', 'The body must be a JSON object.');
  const out: Obj = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    switch (key) {
      case 'Name':
        if (!isStr(v) || !VOLUME_NAME.test(v)) return fail('volume.name', 'That volume name is not allowed.');
        out.Name = v;
        break;
      case 'Driver':
        if (!(v === undefined || v === null || v === '' || v === 'local')) return fail('volume.options', 'Only the local driver is allowed.');
        break;
      case 'DriverOpts':
        if (!emptyish(v)) return fail('volume.options', 'Volume driver options are not allowed.');
        break;
      case 'Labels': {
        if (v === null || v === undefined) break;
        if (!isObj(v) || Object.keys(v).length > 32 || Object.entries(v).some(([k, x]) => k.length > 128 || typeof x !== 'string' || x.length > 1024)) return fail('body', 'Labels are not valid.');
        out.Labels = v;
        break;
      }
      default:
        return fail('body', `The volume field ${JSON.stringify(key.slice(0, 40))} is not allowed.`);
    }
  }
  if (!out.Name) return fail('volume.name', 'A volume needs a name.');
  return { ok: true, body: out };
}
