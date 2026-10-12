// Where a workspace path lives on the machine the `host` service runs on (docs/prd/targets-connect.md §11.6).
//  - Host: the same mapping as This machine (workspaces/hostexec.ts): `/home/node` is the user's home, `/etc/claudepilot` is
//    `~/.claudepilot/host`, anything else is as it is. A `sh -c` script gets the `/etc/claudepilot/` prefix replaced too, which is what
//    `LocalRuntime.delivery.run` does for the scripts the delivery engine sends.
//  - Container: nothing is mapped; the container is the workspace.
import { ETC, hostDir, hostPath } from '../../../../workspaces/hostexec.js';

export interface HostPaths {
  readonly mode: 'host' | 'container';
  /** The home folder commands run in. */
  readonly home: string;
  /** The root a mapped path must stay under when it came from a mapped prefix (null: nothing to confine). */
  confine(workspacePath: string): string | null;
  map(path: string): string;
  /** An argv with its path arguments mapped (and a `sh -c` script's `/etc/claudepilot/` replaced). */
  mapArgv(argv: string[]): string[];
}

export function hostPaths(mode: 'host' | 'container', home: string): HostPaths {
  if (mode === 'container') {
    return { mode, home, confine: () => null, map: (p) => p, mapArgv: (a) => a };
  }
  const map = (p: string) => hostPath(p, home);
  const isShellScript = (argv: string[]) => argv.length >= 3 && /(^|\/)(ba|da|a|z)?sh$/.test(argv[0]!) && argv[1] === '-c';
  return {
    mode,
    home,
    confine: (p) => {
      const under = (dir: string) => p === dir || p.startsWith(`${dir}/`);
      if (under('/home/node')) return home;
      if (under(ETC)) return hostDir(home);
      return null;
    },
    map,
    mapArgv: (argv) => {
      const mapped = argv.map((a) => map(a));
      if (isShellScript(argv)) mapped[2] = argv[2]!.split(`${ETC}/`).join(`${hostDir(home)}/`);
      return mapped;
    },
  };
}
