import type { SecretsMigrationFinding } from '@portal/contracts';
import type { DeliveryAccess } from '../workspaces/runtime.js';

/**
 * The migration check (FR15, A13): what the workspace user set up by hand that a set takes over or that
 * keeps winning (PRD §10.6), reported by existence and name only. It lists credential files in the home
 * folder, the names (never values) of credential variables that shell profiles export or the container
 * sets, and the types of git credential helpers. It never prints a file, a value or a helper's command.
 */
const SCRIPT = `
H=/home/node
for f in .git-credentials .netrc .config/gh/hosts.yml .npmrc .aws/credentials .aws/config .config/gcloud/application_default_credentials.json .docker/config.json .kube/config .ssh/config; do
  [ -e "$H/$f" ] && echo "file $f"
done
for k in "$H"/.ssh/id_*; do
  case "$k" in *.pub) continue ;; esac
  [ -e "$k" ] && echo "file .ssh/\${k##*/}"
done
pat='^(GH|GITHUB|GH_ENTERPRISE|GITHUB_ENTERPRISE)_TOKEN$|^(NPM_TOKEN|NODE_AUTH_TOKEN)$|^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)$|^(GOOGLE_APPLICATION_CREDENTIALS|KUBECONFIG|DOCKER_CONFIG|GH_CONFIG_DIR)$'
for f in .bashrc .profile .bash_profile .zshrc .zprofile .zshenv; do
  [ -f "$H/$f" ] || continue
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\\2/p' "$H/$f" | grep -E "$pat" | sort -u | while read -r n; do echo "export $f $n"; done
done
env | cut -d= -f1 | grep -E "$pat" | sort -u | while read -r n; do echo "env $n"; done
git config --get-regexp '^credential\\..*helper$' 2>/dev/null | while read -r _ h; do
  case "$h" in
    '') ;;
    store*) echo "helper store" ;;
    cache*) echo "helper cache" ;;
    *vscode*|*remote-containers*|*codespaces*|*gitpod*|*jetbrains*|*forward*) echo "helper forwarding" ;;
    *) echo "helper other" ;;
  esac
done
`;

/** What each home file means while a set is assigned, and the §10.6 cleanup step. */
const FILES: Record<string, string> = {
  '.git-credentials': 'A storing git helper wrote tokens here, and may copy the portal’s token here too. Delete it and remove the storing helper.',
  '.netrc': 'git and curl may send these credentials. Remove the entries for hosts the portal handles.',
  '.config/gh/hosts.yml': 'Your own gh login. A GitHub login from the portal hides it; run gh auth logout.',
  '.npmrc': 'It outranks the portal’s npm file. Remove its _authToken lines.',
  '.aws/credentials': 'The portal’s AWS files replace it while assigned, but exported AWS keys still win. Remove the file and exports.',
  '.aws/config': 'The portal’s AWS files replace it while assigned. Remove it.',
  '.config/gcloud/application_default_credentials.json': 'The portal’s Google Cloud file replaces it while assigned. Remove it.',
  '.docker/config.json': 'The portal’s registry file replaces it while assigned. Remove it.',
  '.kube/config': 'Kept: the portal’s kubeconfig is read first and your contexts stay available.',
  '.ssh/config': 'Read before the portal’s and wins for every option it sets. Remove matching Host blocks.',
};

const HELPERS: Record<string, string> = {
  store: 'A storing git helper writes every token git uses to ~/.git-credentials, the portal’s included. Remove it: git config --global --unset-all credential.helper.',
  cache: 'A caching git helper keeps tokens in memory for a while. Usually fine.',
  forwarding: 'An editor’s git helper can copy tokens git uses to your computer. Check your editor’s settings.',
  other: 'Another git credential helper. Check what it does with the tokens git hands it.',
};

/** Turns the script's lines into findings: unknown lines are dropped, never shown. */
export function parseFindings(stdout: string): SecretsMigrationFinding[] {
  const out = new Map<string, SecretsMigrationFinding>();
  for (const line of stdout.split('\n')) {
    const [kind, a, b] = line.trim().split(' ');
    if (kind === 'file' && a) {
      const cleanup = FILES[a] ?? (/^\.ssh\/id_[A-Za-z0-9_.-]+$/.test(a) ? 'A key of your own: ssh may offer it before the portal’s. Remove keys the portal replaces.' : null);
      if (cleanup) out.set(`file:${a}`, { id: `file:${a}`, label: `~/${a}`, cleanup });
    } else if (kind === 'export' && a && b && /^[A-Za-z_][A-Za-z0-9_]*$/.test(b) && /^\.[a-z_]+$/.test(a)) {
      out.set(`export:${a}:${b}`, { id: `export:${a}:${b}`, label: `~/${a} exports ${b}`, cleanup: 'In terminals your profile runs after the portal’s and wins; inside Claude Code the portal wins. Remove the export.' });
    } else if (kind === 'env' && a && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
      out.set(`env:${a}`, { id: `env:${a}`, label: `The workspace’s environment sets ${a}`, cleanup: 'Set when the workspace was created. Inside Claude Code the portal’s value wins.' });
    } else if (kind === 'helper' && a && HELPERS[a]) {
      out.set(`helper:${a}`, { id: `helper:${a}`, label: `A git credential helper (${a})`, cleanup: HELPERS[a]! });
    }
  }
  return [...out.values()];
}

/** Runs the check as the workspace user; null when the workspace isn't running. */
export async function checkHomeCredentials(access: DeliveryAccess, name: string): Promise<SecretsMigrationFinding[] | null> {
  const state = await access.state(name);
  if (!state.running) return null;
  const r = await access.run(name, SCRIPT, { user: 'node', timeoutMs: 15_000 });
  return parseFindings(r.stdout);
}
