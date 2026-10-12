// T-AGENT: configuration (docs/prd/targets-connect.md §10.3, §11.3): the environment over agent.json, key by key; the modes and the services they
// offer; the data folders; the policy widening that comes from agent.json only; the refusals that stop the agent from starting.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, defaultDataDir, loadConfig, MODE_SERVICES, readAgentFile } from './config.js';

const noFile = () => ({});

describe('loadConfig', () => {
  it('needs a mode, and takes the services from it', () => {
    assert.throws(() => loadConfig({}, noFile), ConfigError);
    assert.throws(() => loadConfig({ PILOT_MODE: 'vm' }, noFile), /must be one of/);
    for (const [mode, services] of Object.entries(MODE_SERVICES)) assert.deepEqual(loadConfig({ PILOT_MODE: mode }, noFile).services, services, mode);
    assert.deepEqual(MODE_SERVICES, { docker: ['docker'], swarm: ['docker'], kubernetes: ['kube'], container: ['host'], host: ['host'] });
  });

  it('the data folder follows the mode: the user’s home for a host, the state volume for containers; the environment wins', () => {
    assert.equal(defaultDataDir('host', { HOME: '/home/ann' }), '/home/ann/.claudepilot/agent');
    for (const mode of ['docker', 'swarm', 'kubernetes', 'container'] as const) assert.equal(defaultDataDir(mode), '/var/lib/claudepilot-agent');
    assert.equal(loadConfig({ PILOT_MODE: 'host', HOME: '/home/ann' }, noFile).dataDir, '/home/ann/.claudepilot/agent');
    assert.equal(loadConfig({ PILOT_MODE: 'host', PILOT_DATA_DIR: '/data' }, noFile).dataDir, '/data');
  });

  it('reads agent.json and lets the environment win, key by key', () => {
    const file = () => ({ url: 'https://old.example.com', mode: 'docker', images: ['a:1'], dockerSocket: '/run/a.sock', namespace: 'n1', nodeName: 'from-file', docker: { allowImages: ['x:1'], allowBinds: ['/srv'] }, home: '/h' });
    const c = loadConfig({ PILOT_URL: 'https://new.example.com/', PILOT_IMAGES: 'b:2, c:3', PILOT_DOCKER_SOCKET: '/run/b.sock', PILOT_LOG_LEVEL: 'debug' }, file);
    assert.equal(c.mode, 'docker');
    assert.equal(c.url, 'https://new.example.com', 'the trailing slash goes');
    assert.deepEqual(c.images, ['b:2', 'c:3', 'a:1']);
    assert.equal(c.dockerSocket, '/run/b.sock');
    assert.equal(c.kubeNamespace, 'n1');
    assert.equal(c.nodeName, 'from-file');
    assert.equal(c.logLevel, 'debug');
    assert.equal(c.home, '/h');
    assert.deepEqual(c.docker, { allowImages: ['x:1'], allowBinds: ['/srv'] });
  });

  it('the policy’s local widening comes from agent.json only, never from the environment', () => {
    const c = loadConfig({ PILOT_MODE: 'docker', PILOT_DOCKER_ALLOW_BINDS: '/', PILOT_ALLOW_IMAGES: '*' }, noFile);
    assert.deepEqual(c.docker, { allowImages: [], allowBinds: [] });
  });

  it('refuses a plain http portal address unless it is loopback or the host said so', () => {
    assert.throws(() => loadConfig({ PILOT_MODE: 'host', PILOT_URL: 'http://pilot.example.com' }, noFile), /https/);
    assert.equal(loadConfig({ PILOT_MODE: 'host', PILOT_URL: 'http://127.0.0.1:3000' }, noFile).url, 'http://127.0.0.1:3000');
    assert.equal(loadConfig({ PILOT_MODE: 'host', PILOT_URL: 'http://172.18.0.1:3216', PILOT_ALLOW_HTTP: '1' }, noFile).allowHttp, true);
    assert.throws(() => loadConfig({ PILOT_MODE: 'host', PILOT_URL: 'https://user:pass@pilot.example.com' }, noFile), /password|user name/);
    assert.throws(() => loadConfig({ PILOT_MODE: 'host', PILOT_URL: 'https://pilot.example.com/some/path' }, noFile), /no path/);
  });

  it('agent.json may switch a service off but not add one the mode does not offer', () => {
    assert.deepEqual(loadConfig({ PILOT_MODE: 'docker' }, () => ({ services: ['docker', 'host'] })).services, ['docker']);
    assert.deepEqual(loadConfig({ PILOT_MODE: 'docker' }, () => ({ services: ['host'] })).services, [], 'a docker agent never offers host, whatever the file says');
  });

  it('holds the secrets in their own fields and parses the extra headers', () => {
    const c = loadConfig({ PILOT_MODE: 'kubernetes', PILOT_ENROLL_TOKEN: 'cpen_x', PILOT_IDENTITY_SECRET: 'claudepilot-agent-identity', PILOT_HEADERS: 'CF-Access-Client-Id: a\nCF-Access-Client-Secret: b', PILOT_KUBE_NAMESPACE: 'ws' }, noFile);
    assert.equal(c.enrollToken, 'cpen_x');
    assert.equal(c.identitySecret, 'claudepilot-agent-identity');
    assert.deepEqual(c.headers, { 'CF-Access-Client-Id': 'a', 'CF-Access-Client-Secret': 'b' });
    assert.equal(loadConfig({ PILOT_MODE: 'host', PILOT_ENROLL_TOKEN: '' }, noFile).enrollToken, null);
  });

  it('reads the extra headers from the installer’s file when PILOT_HEADERS is not set (so a service token never sits in docker inspect), and the variable wins', () => {
    const files: Record<string, string> = { '/data/headers': 'CF-Access-Client-Id: from-file\nCF-Access-Client-Secret: file-secret\n' };
    const read = (p: string) => files[p] ?? null;
    const fromFile = loadConfig({ PILOT_MODE: 'host', PILOT_DATA_DIR: '/data' }, noFile, read);
    assert.deepEqual(fromFile.headers, { 'CF-Access-Client-Id': 'from-file', 'CF-Access-Client-Secret': 'file-secret' });
    assert.deepEqual(loadConfig({ PILOT_MODE: 'host', PILOT_DATA_DIR: '/data', PILOT_HEADERS: 'X-One: 1' }, noFile, read).headers, { 'X-One': '1' });
    assert.deepEqual(loadConfig({ PILOT_MODE: 'host', PILOT_DATA_DIR: '/elsewhere' }, noFile, read).headers, {});
  });

  it('readAgentFile: missing is empty, damaged is an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx2-cfg-'));
    try {
      assert.deepEqual(readAgentFile(join(dir, 'none')), {});
      mkdirSync(join(dir, 'd'));
      writeFileSync(join(dir, 'd', 'agent.json'), '{"mode":"host"');
      assert.throws(() => readAgentFile(join(dir, 'd')), /not valid JSON/);
      writeFileSync(join(dir, 'd', 'agent.json'), '[1,2]');
      assert.deepEqual(readAgentFile(join(dir, 'd')), {});
      writeFileSync(join(dir, 'd', 'agent.json'), '{"mode":"host","url":"https://p.example.com"}');
      assert.equal(loadConfig({ PILOT_DATA_DIR: join(dir, 'd') }).url, 'https://p.example.com', 'the mode and the address come from the file in the data folder');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
