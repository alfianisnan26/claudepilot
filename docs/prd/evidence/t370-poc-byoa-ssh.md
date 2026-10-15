# PoC: Bring Your Own Agent lewat SSH ke workspace bersama (T-370, S0)

| | |
| --- | --- |
| Tanggal | 2026-10-15 |
| Tiket | T-370 (S0 spike), induk T-362 (D-53), desain [workspace-ssh.md](../workspace-ssh.md) v0.2, keputusan D-56 |
| Siapa | sesi `claudepilot-b7` (VS Code), atas permintaan owner |
| Skrip | [`tools/poc/byoa-ssh/`](../../../tools/poc/byoa-ssh/) — `poc.sh up` / `poc.sh down`, bisa diulang dari nol |
| Hasil | **Jalan.** SSH lewat portal, satu Unix user per orang, Claude Code dan 4 agent CLI lain, request/response lewat tunnel, pilot bisa melihat sesinya. Yang belum diuji ada di bagian 9. |

## 1. Ringkasan

Orang konek dari desktop masing-masing pakai `ssh` biasa. Koneksinya **lewat portal** (WebSocket + token orang itu), lalu masuk ke
`sshd -i` yang dijalankan khusus untuk koneksi itu di dalam workspace. Tidak ada port baru yang dibuka. Tiap orang jadi Unix user sendiri
(`p-alice`, `p-bob`) dengan home 700, tanpa `sudo`, jadi tidak bisa memakai login agent orang lain, Claude milik portal, atau kunci pool.
Claude Code, Codex, Gemini, Copilot dan Cursor semua bisa dijalankan dari desktop lewat tunnel ini, termasuk lewat protokol ACP. Pilot
melihat siapa yang konek, sesi apa yang jalan, branch-nya, dan transcript-nya (read only).

| Kebutuhan owner | Status | Bukti |
| --- | --- | --- |
| Konek dari desktop sendiri, aman, lewat SSH | ✅ | bagian 4.1 |
| User login agent sendiri di workspace | ✅ Claude (dan 4 CLI lain terpasang di home sendiri) | 4.5, 4.6 |
| Satu Unix user per orang, tidak bisa pakai login agent orang lain | ✅ 14 dari 14 cek ditolak | 4.2 |
| Pilot tahu siapa, sesi apa, branch apa, transcript | ✅ dari hooks + outbox per orang | 4.8 |
| Request/response agent bisa di-tunnel | ✅ Claude, Codex, Gemini penuh; Copilot dan Cursor sampai batas login | 4.6, 4.7 |
| Bisa dicabut seketika | ✅ putus ±90 ms, semua proses orang itu mati (termasuk yang detached) | 4.4 |
| Ambil tiket pilot lewat Portal MCP (S4) | ⏳ belum diuji di PoC ini | 9 |

## 2. Pendekatan

```
desktop (alice)                          portal (di PoC: bridge.mjs)                 workspace (container)
ssh poc-ws                               cek token -> orang (alice)                  sudo sshd -i  (1 proses per koneksi)
  ProxyCommand pilot-ssh.mjs  ──WSS──▶   orang boleh operate workspace?   ──exec──▶    AuthorizedKeysFile = kunci alice saja
  token dari file 600                    tulis authorized_keys + welcome               AllowUsers p-alice
                                         catat koneksi (audit)                         SetEnv PILOT_PERSON, PILOT_CONN_ID
                                                                                     ForceCommand ssh-enter
                                                                                       consent sekali, welcome, lalu shell/perintah
```

- **Kenapa lewat portal, bukan buka port SSH:** satu pintu saja (URL portal yang sudah ada), auth dan audit di portal, dicabut dengan
  menutup WebSocket. Workspace tidak listen di port apa pun; `sshd -i` bicara SSH lewat stdin/stdout exec yang sama dengan web shell.
- **Dua kunci:** token (pintu portal) + public key orang itu (pintu sshd). Token bob dengan kunci alice ditolak, dan sebaliknya.
- **Root hanya untuk sshd:** `sudo sshd -i` (lewat `sudo` milik user `node`) supaya bisa pindah ke user orang itu, seperti sshd biasa.
- **Pengamatan kooperatif:** managed hook Claude Code menulis satu baris per event ke outbox di home orang itu; portal membacanya sebagai
  root. Catatan koneksi tidak bisa dihindari (semua lewat portal).

## 3. Lingkungan uji

| Hal | Nilai |
| --- | --- |
| Image workspace | `claudepilot-workspace:cc-2.1.296` (image asli, Debian 12, Claude Code 2.1.296) + `openssh-server` (OpenSSH 9.2) |
| Runtime | Docker 29.9.0, linux/arm64, di container dev ini (8 CPU terlihat, 11 GiB) |
| Desktop | OpenSSH client + Node 22.23.3 (`pilot-ssh.mjs` pakai WebSocket bawaan Node) |
| Orang | `alice` (uid 20001), `bob` (uid 20002), grup `pilot-people` |
| Model API | **palsu**: stand-in Anthropic milik canary (`claudeversion/standin.ts`) dan `fake-llm.cjs` (OpenAI Responses/Chat, Gemini). Tidak ada kredensial asli; token dan key dibuat saat run |
| Pool palsu | kunci account pool `root:node 0440` + `apiKeyHelper`, drop-in Secrets `0440 root:node`, sama bentuknya dengan yang asli (`accounts/pools.ts:577-584`, `delivery/ownership.ts:132-134`) |

## 4. Hasil

### 4.1 Koneksi dan identitas

| Tes | Hasil |
| --- | --- |
| `ssh poc-ws whoami` sebelum consent | ditolak: "pilot: connect once from a terminal to accept" ✅ |
| Login interaktif pertama | layar consent → `yes` → welcome (orang, workspace, siapa online, tiket, aturan) ✅ |
| Setelah consent | `uid=20001(p-alice)`, home `/home/people/alice`, `PILOT_PERSON=alice`, `PILOT_CONN_ID=<id>` ✅ |
| Token bob, minta jadi `p-alice` | `Permission denied (publickey)` ✅ (`AllowUsers` per koneksi) |
| Token bob, kunci alice | `Permission denied (publickey)` ✅ |
| Tanpa token | ditolak di portal (404), tercatat `ssh.refused: no token` ✅ |
| Token benar, workspace lain | ditolak (404), tercatat `ssh.refused: workspace` ✅ |
| Dua orang bersamaan | dua koneksi live, welcome alice: "online now: bob" ✅ |

### 4.2 Isolasi per orang (dijalankan sebagai alice)

| Cek | Hasil |
| --- | --- |
| Baca file di home bob / list home bob | Permission denied ✅ |
| List home `node` / baca login Claude milik portal (`/home/node/.claude/.credentials.json`) | Permission denied ✅ |
| Baca host key sshd | Permission denied ✅ |
| Baca kunci account pool / jalankan `apiKeyHelper` pool | Permission denied ✅ |
| Baca drop-in Secrets (env berisi secret) | Permission denied ✅ |
| `sudo -n true` | "a password is required" ✅ |
| `su node`, `su p-bob` | Authentication failure ✅ |
| Baca environ proses lain (`/proc/1/environ`) | Permission denied ✅ |
| Tulis ke checkout bersama di `/home/node` | Permission denied ✅ |
| Docker socket | tidak ada ✅ |

14 dari 14 ditolak.

### 4.3 Forwarding

| Tes | Hasil |
| --- | --- |
| Local forward `-L` (dipakai VS Code Remote-SSH) ke server di workspace | HTTP 200 ✅ |
| Remote forward `-R` | "remote port forwarding failed" ✅ ditolak |
| Agent forwarding `-A` | `SSH_AUTH_SOCK` kosong di workspace ✅ ditolak |

### 4.4 Pencabutan (revoke)

| Tes | Hasil |
| --- | --- |
| Revoke bob saat konek, dengan proses detached (seperti server VS Code) | ssh bob putus **±90 ms** setelah revoke ("pilot-ssh: access revoked"); proses bob 4 → **0** ✅ |
| Putus normal (bukan revoke) | proses detached **tetap hidup** (memang perlu: server VS Code bisa reconnect) ✅ |
| Revoke saat bob tidak konek | proses detached sisa 2 → **0** ✅ (setelah perbaikan, lihat 5) |
| Konek lagi dengan token yang dicabut | ditolak ✅ |

### 4.5 Claude Code (2.1.296) sebagai alice, lewat tunnel

| Tes | Hasil |
| --- | --- |
| `claude -p "say hi" --output-format stream-json` dengan key alice sendiri (ke stand-in) | `success`: "Hello from the stand-in model, through the tunnel." ✅ |
| Drop-in Secrets yang tidak bisa dibaca alice | Claude jalan, dengan peringatan "Managed settings failed to load; policies from the failed source are NOT in effect" (lihat temuan 5.6) |
| `apiKeyHelper` account pool ikut berlaku untuk alice | "apiKeyHelper failed: … Permission denied", lalu Claude memakai key alice sendiri (`apiKeySource: ANTHROPIC_API_KEY`) — kunci pool tidak bocor ✅ |
| Hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`) | 4 baris per sesi di outbox alice, berisi `session_id`, `transcript_path`, `cwd`, person, conn, branch ✅ |
| Transcript dibaca portal (sebagai root, read only) | 19 baris JSONL; teks asisten terakhir terbaca ✅ |

### 4.6 Agent CLI lain (dipasang di home alice, lewat tunnel)

| CLI | Versi | Mode headless | Model ke stand-in? | Lewat tunnel | ACP | Login |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | 0.162.1 | `codex exec --json` (event JSONL) | ✅ provider custom (`base_url`, Responses API) | ✅ jawaban + usage (10 in / 9 out) | — (ada `codex app-server` JSON-RPC: `initialize` ✅ lewat tunnel) | ChatGPT atau API key |
| Gemini | 0.64.0 | `gemini -p -o stream-json` | ✅ `GOOGLE_GEMINI_BASE_URL` | ✅ jawaban + stats | ✅ `--acp`: initialize → session → prompt → jawaban | API key (AI Studio / Gemini API berbayar), Vertex, atau Code Assist Standard/Enterprise. **Login Google pribadi sudah tidak bisa** (lihat catatan di bawah) |
| Copilot | 1.0.98 | `copilot -p` | ❌ tidak ada override | sampai login: pesan "set COPILOT_GITHUB_TOKEN / gh auth login" | ✅ `--acp`: initialize ok, `session/new` → "Authentication required" | `copilot-login` (GitHub) |
| Cursor | 2026.10.14-941492e | `cursor-agent -p --output-format stream-json` | ❌ tidak ada override | sampai login: "run 'agent login' or set CURSOR_API_KEY" | ✅ `cursor-agent acp`: initialize ok, `session/new` → "Authentication required" | `cursor_login` atau `CURSOR_API_KEY` |

**Catatan Gemini (simulasi dengan login asli, 2026-10-15):** setelah owner login Google di Gemini CLI 0.64.0, CLI langsung mengganti
tipe auth di `~/.gemini/settings.json` ke `gemini-api-key` (jam 01:41:08 `google_accounts.json`, `settings.json` dan `state.json` berubah
bersamaan; `oauth_creds.json` tidak pernah dibuat) dan meminta API key. Sebabnya bukan paket akun: menurut beberapa sumber, Google
menghentikan login Google pribadi untuk Gemini CLI sejak 2026-06-18 untuk akun gratis, AI Pro maupun AI Ultra; yang masih jalan adalah
API key dan lisensi organisasi Code Assist Standard/Enterprise (pengumuman Google sendiri belum kami buka langsung). Jadi untuk BYOA,
"login Gemini" berarti API key milik orang itu atau lisensi organisasi.

Tempat tiap agent menyimpan sesinya (di home orang itu, jadi portal bisa membacanya untuk pengamatan): Claude
`~/.claude/projects/<folder>/<id>.jsonl`, Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, Gemini `~/.gemini/tmp/<proj>/chats/session-*.jsonl`,
Copilot `~/.copilot/`, Cursor `~/.cursor/`.

### 4.7 Request/response lewat tunnel: dua lapis

1. **Lapis agent (pilot bicara dengan agent):** `acp-client.mjs` menjalankan agent lewat `ssh` dan bicara JSON-RPC ACP di stdio-nya.
   Gemini: `initialize` 1.308 ms (termasuk buka koneksi SSH), `session/new` +25 ms, prompt sampai jawaban selesai **+57 ms**. Artinya pilot
   bisa menyetir agent apa pun yang bicara ACP, lewat tunnel yang sama, tanpa port tambahan. Copilot (750 ms) dan Cursor (535 ms) sampai
   `initialize` dengan cara yang sama.
2. **Lapis model (agent bicara dengan model):** tiga dari lima agent bisa diarahkan ke endpoint yang kita kontrol (Claude
   `ANTHROPIC_BASE_URL`, Codex `base_url`, Gemini `GOOGLE_GEMINI_BASE_URL`). Stand-in mencatat setiap request (method, path, model, nama
   header; tidak pernah nilainya), misalnya `POST /v1/responses model=stand-in stream=true` (Codex) dan
   `POST /v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse` (Gemini). Jadi metering per orang bisa dibuat lewat proxy
   seperti ini untuk ketiganya; Copilot dan Cursor tidak bisa (backend mereka sendiri), cukup dari transcript.

### 4.8 Yang terlihat di pilot (dibangun dari outbox, seperti ingest S3)

| Sesi | Orang | Koneksi | Event | Waktu |
| --- | --- | --- | --- | --- |
| 840f3826 | alice | f12025fa | SessionStart, UserPromptSubmit, Stop, SessionEnd | 01:01:35 → 01:01:36 |
| a401421d | alice | f54a614d | SessionStart, UserPromptSubmit, Stop, SessionEnd | 01:01:54 → 01:01:54 |
| 6cd56cae | alice | d37f436d | SessionStart, UserPromptSubmit, Stop, SessionEnd | 01:01:55 → 01:01:56 |

Consent tercatat: alice 00:59:15Z, bob 00:59:28Z. Koneksi tercatat di `connections.jsonl`: buka, tutup, durasi, byte masuk/keluar,
alasan (`closed by client`, `revoked`, `sshd exited`), dan penolakan dengan alasannya.

### 4.9 Performa tunnel

| Ukuran | Hasil |
| --- | --- |
| Buka koneksi baru + jalankan `true` (7 kali) | 183, 184, 185, **187** (median), 190, 192, 276 ms |
| Echo round-trip di koneksi yang terbuka (180 pesan) | p50 **0,54 ms**, p95 2,71 ms, maks 17,84 ms |
| Upload 64 MiB | **144 MiB/s** |
| Download 64 MiB | **164 MiB/s** |
| Pembanding: `docker exec` langsung tanpa SSH/WS | 927 MiB/s |
| Memori bridge (Node) | 81 MiB RSS |

Lebih dari cukup untuk terminal, VS Code dan agent. Di cluster, latensi tambahan datang dari jaringan ke portal, bukan dari tunnel.

## 5. Temuan dan perbaikan (masuk ke S1)

| # | Temuan | Tindakan |
| --- | --- | --- |
| 5.1 | `useradd` membuat akun **terkunci** (`!`): sshd menolak login pakai key | set password `*` (tanpa password, tidak terkunci) |
| 5.2 | `AuthorizedKeysFile` per koneksi tanpa `AllowUsers` = kunci orang itu bisa login sebagai user lain | tambah `-o AllowUsers=p-<orang>` per koneksi (tes 4.1) |
| 5.3 | `authorized_keys` per koneksi harus milik root, **bukan** di home orang itu (dia bisa menambah kunci sendiri) | simpan di `/etc/claudepilot/ssh/conn/<id>/` (root 644); PRD bagian 4 dikoreksi |
| 5.4 | Cara pertama mematikan proses per koneksi butuh membaca environ proses (diblok aturan deny repo) | revoke = `pkill -u p-<orang>`: satu user per orang membuatnya sederhana dan lengkap |
| 5.5 | Revoke saat orang **tidak** konek tidak mematikan proses detached | revoke selalu mematikan proses orang itu (tes 4.4) |
| 5.6 | Drop-in managed yang tidak bisa dibaca **dilewati** Claude ("NOT in effect"), bukan gagal | aman untuk env Secrets (orang memang tidak boleh dapat), tapi **aturan deny/permission di drop-in seperti itu juga tidak berlaku untuk orang**. Aturan keamanan yang harus berlaku untuk semua orang harus di drop-in yang bisa dibaca semua (root 0644, tanpa secret) |
| 5.7 | `apiKeyHelper` pool berlaku untuk semua user di workspace | dengan key sendiri: dilewati (tes 4.5). Dengan login langganan (OAuth): **belum diuji**. S1 membuat drop-in pool hanya untuk sesi `node` |
| 5.8 | Codex butuh `bubblewrap` untuk sandbox-nya | tambah `bubblewrap` di image |
| 5.9 | 4 CLI = **1,2 GB per orang** (664 MB npm + 551 MB Cursor) | pasang sekali di image (versi di-pin, D-54), bukan per orang |
| 5.10 | Gemini menolak folder yang belum dipercaya | `GEMINI_CLI_TRUST_WORKSPACE=true` di env sesi orang, atau trust per folder |
| 5.11 | Layanan TCP lokal di workspace bisa dijangkau semua orang (TCP tidak kenal user) | catat di layar consent; layanan internal portal jangan listen tanpa auth |
| 5.12 | CLI membuat folder 755 di home (`.codex`, `.copilot`) | aman karena home 700; tambah `umask 077` untuk orang |
| 5.13 | Field `branch` di hook = `HEAD` untuk repo tanpa commit | `git symbolic-ref --short` dulu (sudah diperbaiki di `setup.sh`) |
| 5.14 | Daftar "online now" ikut menampilkan koneksi lain orang yang sama | dedup per orang, tanpa diri sendiri (sudah diperbaiki) |

## 6. Kesimpulan

Pendekatan "SSH lewat portal + satu Unix user per orang + pengamatan lewat hooks" **bisa dipakai** dan murah: tidak ada port baru, auth dan
audit di satu tempat, isolasi memakai fitur Linux biasa, dan semua agent CLI yang diminta bisa jalan di sana. ACP terbukti jadi jalur
bersama untuk menyetir agent lain lewat tunnel yang sama (D-54). Tiga agent (Claude, Codex, Gemini) juga bisa dimeter di lapis model.

## 7. Cara menjalankan ulang

```sh
tools/poc/byoa-ssh/poc.sh up                         # image, workspace, alice dan bob, stand-in model, bridge
ssh -F /tmp/cp-poc-byoa/desk/alice/ssh_config poc-ws # pertama kali interaktif: consent
curl 127.0.0.1:7789/live                             # koneksi live
curl '127.0.0.1:7789/revoke?person=bob'              # cabut bob
ACP_CWD=/home/people/alice node tools/poc/byoa-ssh/acp-client.mjs /tmp/cp-poc-byoa/desk/alice/ssh_config 'gemini --acp'
node tools/poc/byoa-ssh/rtt.mjs /tmp/cp-poc-byoa/desk/alice/ssh_config   # latensi
tools/poc/byoa-ssh/poc.sh down
```

Butuh image `claudepilot-workspace:cc-2.1.296` di Docker lokal (atau `BASE=<image>`). Sejak simulasi kedua (di bawah), Gemini, Codex
dan Cursor dipasang **sekali di image** (versi di-pin, plus `bubblewrap`), sesuai temuan 5.8 dan 5.9.

**Simulasi dengan login asli** (owner, 2026-10-15: login sendiri di Claude, Gemini dan Cursor lewat SSH):

```sh
PEOPLE="alfian bob" FAKE_POOL=0 tools/poc/byoa-ssh/poc.sh up   # orang sesuai nama, tanpa pool palsu
ssh -F /tmp/cp-poc-byoa/desk/alfian/ssh_config poc-ws           # consent, lalu: claude (/login), gemini, cursor-agent login
PEOPLE="alfian bob" tools/poc/byoa-ssh/poc.sh view              # yang dilihat pilot: koneksi, sesi, status login (tanpa membaca isinya)
tools/poc/byoa-ssh/poc.sh down                                  # hapus container: semua login di dalamnya ikut hilang
```

Untuk orang (`pilot-people`) sesi SSH memakai `umask 077` dan `NO_BROWSER=true`, jadi login agent memberi URL untuk dibuka di browser
desktop dan kode untuk ditempel kembali.

## 8. Yang berubah di desain (PRD workspace-ssh.md)

- `authorized_keys` per koneksi di `/etc/claudepilot/ssh/conn/<id>/` milik root, plus `AllowUsers` per koneksi (5.2, 5.3).
- Revoke = semua proses user orang itu, juga saat tidak konek (5.4, 5.5).
- Aturan keamanan untuk semua orang tidak boleh di drop-in yang tidak terbaca (5.6); drop-in pool hanya untuk `node` (5.7).
- CLI agent di image, bukan per orang; `bubblewrap` ikut (5.8, 5.9).

## 9. Belum diuji (jujur)

- **Kubernetes** (`kubectl exec` biner tanpa TTY, `sudo` di pod, mount home dengan `subPath`, token service account): hanya Docker di PoC ini.
- **VS Code Remote-SSH sungguhan** (tidak ada GUI di sini): yang diuji adalah yang dia butuhkan, yaitu local forward dan proses detached
  yang bertahan setelah putus normal.
- **Login asli** (langganan Claude, ChatGPT, Google, GitHub Copilot, Cursor): sengaja tidak; model memakai stand-in, Copilot dan Cursor
  diuji sampai batas login. Perilaku `apiKeyHelper` pool terhadap login langganan belum diketahui (5.7).
- **Ambil tiket lewat Portal MCP (S4)** dan **ingest di portal sungguhan (S3)**: PoC hanya membuktikan datanya ada (outbox, transcript).
- **Connect** (host jarak jauh): di luar PoC.
