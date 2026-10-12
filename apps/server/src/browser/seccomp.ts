import moby from './pinned/seccomp-default.json' with { type: 'json' };

/**
 * The seccomp profile the browser container runs under (browser & desktop PRD §13 Chrome sandbox).
 *
 * Chromium's sandbox needs user namespaces, which Docker's default profile refuses without CAP_SYS_ADMIN
 * (a non-root Chromium then dies with "No usable sandbox"). Neither seccomp=unconfined nor SYS_ADMIN is
 * acceptable, so this is moby's default profile (`pinned/seccomp-default.json`, from github.com/moby/profiles,
 * Apache-2.0) plus the four calls the namespace sandbox makes: `clone` and `unshare` with the namespace flags,
 * `setns`, and `chroot` (the sandbox's own file-system lockdown, which the default allows only with
 * CAP_SYS_CHROOT, and the container has dropped every capability). Observed on Docker 29.9 DinD, arm64: a
 * non-root Chromium 154 starts with its sandbox under this profile, `CapDrop: ALL` and `no-new-privileges`.
 */
export const SANDBOX_SYSCALLS = ['unshare', 'setns', 'clone', 'chroot'] as const;

export function chromeSeccompProfile(): string {
  const profile = structuredClone(moby) as { syscalls: unknown[] };
  profile.syscalls.push({ names: [...SANDBOX_SYSCALLS], action: 'SCMP_ACT_ALLOW', comment: 'user namespaces for the Chromium sandbox' });
  return JSON.stringify(profile);
}
