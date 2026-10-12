# ClaudePilot Connect installer for Windows PowerShell 5.1 and PowerShell 7 (docs/prd/targets-connect.md section 13). The same bytes for
# everyone: what varies comes from the plan the portal answers for your token. Read it before you run it; the portal shows its sha256.
#
#   $env:PILOT_URL='<portal>'; $env:PILOT_TOKEN='<token>'; irm <portal>/connect/install.ps1 | iex
#   $env:PILOT_URL='<portal>'; & ([scriptblock]::Create((irm <portal>/connect/install.ps1))) upgrade|uninstall [--purge]|doctor|status
#
# Kinds: docker, swarm, kubernetes and container (Docker Desktop with Linux containers; kubectl). A Windows host is WSL2: run the Linux
# command in a WSL2 shell. The token is removed from the environment at once, sent only in the Authorization header and handed to the
# agent on stdin; never printed. PILOT_DRY_RUN=1 shows the plan and the commands and changes nothing; PILOT_YES=1 answers questions.
# Exit codes as install.sh: 10 preflight, 11 portal unreachable, 12 token rejected, 13 download or checksum, 14 install, 15 not connected
# in time, 20 declined. The last line is PILOT_RESULT=connected|installed|removed|ok|failed|dry-run. Under `irm | iex` nothing calls
# `exit` (it would close your window): the code is left in $LASTEXITCODE.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:Tok = $env:PILOT_TOKEN
$script:Hdrs = $env:PILOT_HEADERS
Remove-Item Env:PILOT_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:PILOT_HEADERS -ErrorAction SilentlyContinue

# The bootstrap fetcher (src/connect/install/fetcher.ts; a test keeps this line equal to it). Passed to containers in an environment
# variable, never as an argument (Windows PowerShell 5.1 mangles quotes in native arguments).
$script:Fetcher = 'const [u,h,o]=process.argv.slice(1),fs=require("fs"),p=require("path"),c=require("crypto");const die=(m)=>{console.error("fetch: "+m);process.exit(13)};if(!/^[0-9a-f]{64}$|^sha512-[A-Za-z0-9+\/]{86}==$/.test(h||"")||!u||!o)die("usage: <url> <sha256|sha512-integrity> <out>");const sum=(b)=>h.startsWith("sha512-")?"sha512-"+c.createHash("sha512").update(b).digest("base64"):c.createHash("sha256").update(b).digest("hex");try{if(sum(fs.readFileSync(o))===h)process.exit(0)}catch{}const hd={},hf=process.env.PILOT_HEADERS_FILE;if(hf)for(const l of fs.readFileSync(hf,"utf8").split(/\r?\n/)){const i=l.indexOf(":");if(i>0)hd[l.slice(0,i).trim()]=l.slice(i+1).trim()}let n="";try{n=new URL(u).pathname}catch{die("not an address")}fetch(u,{headers:hd,redirect:"follow"}).then(async(r)=>{if(!r.ok)die("HTTP "+r.status+" for "+n);const b=Buffer.from(await r.arrayBuffer());if(sum(b)!==h)die("checksum mismatch for "+n);fs.mkdirSync(p.dirname(o),{recursive:true});fs.writeFileSync(o+".tmp",b,{mode:0o644});fs.renameSync(o+".tmp",o)},(e)=>die("download failed for "+n+" ("+String((e&&e.cause&&e.cause.code)||(e&&e.message)||e)+")"));'

$script:CData = '/var/lib/claudepilot-agent'
$script:CAgent = '/opt/claudepilot-agent'
$script:Dry = ($env:PILOT_DRY_RUN -eq '1')
$script:Yes = ($env:PILOT_YES -eq '1')
$script:WaitS = 120
if ($env:PILOT_WAIT_SECONDS) { $script:WaitS = [int]$env:PILOT_WAIT_SECONDS }
$script:PollS = 2
if ($env:PILOT_POLL_SECONDS) { $script:PollS = [int]$env:PILOT_POLL_SECONDS }
$script:Url = ''
if ($env:PILOT_URL) { $script:Url = $env:PILOT_URL.TrimEnd('/') }
$script:Purge = $false
$script:Plan = @{}
$script:Tmp = $null

class PilotExit : System.Exception {
  [int]$Code
  [string]$Result
  PilotExit([int]$code, [string]$result, [string]$message) : base($message) { $this.Code = $code; $this.Result = $result }
}

function Write-Say([string]$m) { Write-Host $m }
function Write-Step([string]$m) { Write-Host "==> $m" }
function Stop-Pilot([int]$code, [string]$message) { throw [PilotExit]::new($code, 'failed', $message) }
function Complete-Pilot([int]$code, [string]$result) { throw [PilotExit]::new($code, $result, '') }

function Show-Command([string[]]$a) {
  $shown = foreach ($x in $a) {
    if ($x -eq $script:Fetcher) { '<fetcher>' } elseif ($x -match '^[A-Za-z0-9._:/@,+=%{}-]+$') { $x } else { "'$x'" }
  }
  Write-Host ('  $ ' + ($shown -join ' '))
}

# Runs a native command (docker, kubectl): says it first; in a dry run only says it. Returns the exit code.
function Invoke-Native([string[]]$a, $stdin = $null, [string]$stdinNote = '') {
  Show-Command $a
  if ($stdinNote) { Write-Host "    (stdin: $stdinNote)" }
  if ($script:Dry) { return 0 }
  $exe = $a[0]
  $rest = @()
  if ($a.Length -gt 1) { $rest = $a[1..($a.Length - 1)] }
  if ($null -ne $stdin) { $stdin | & $exe @rest | Out-Host } else { & $exe @rest | Out-Host }
  return $LASTEXITCODE
}

# Reads a native command's output quietly (checks, not changes); $null when it fails.
function Get-Native([string[]]$a) {
  $exe = $a[0]
  $rest = @()
  if ($a.Length -gt 1) { $rest = $a[1..($a.Length - 1)] }
  try { $out = & $exe @rest 2>$null } catch { return $null }
  if ($LASTEXITCODE -ne 0) { return $null }
  return (($out | Out-String).Trim())
}

function Confirm-Pilot([string]$question) {
  if ($script:Yes) { return }
  if ($script:Dry) { Write-Say "(would ask: $question)"; return }
  $answer = Read-Host "$question [yes/no]"
  if ($answer -ne 'yes') { throw [PilotExit]::new(20, 'failed', 'Declined.') }
}

# ---------------------------------------------------------------------------------------------------------------------------------
# HTTP to the portal

function Get-Headers([bool]$auth) {
  $h = @{}
  if ($script:Hdrs) {
    foreach ($line in ($script:Hdrs -split "`r?`n")) {
      $i = $line.IndexOf(':')
      if ($i -gt 0) { $h[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim() }
    }
  }
  if ($auth) { $h['Authorization'] = "Bearer $($script:Tok)" }
  return $h
}

# @{ Status; Body } for any HTTP answer; Stop-Pilot 11 when nothing answered.
function Invoke-Portal([string]$path, [bool]$auth = $false, [string]$outFile = '') {
  $params = @{ Uri = "$($script:Url)$path"; Headers = (Get-Headers $auth); UseBasicParsing = $true; TimeoutSec = 300 }
  if ($outFile) { $params['OutFile'] = $outFile; $params['PassThru'] = $true }
  # PowerShell 7 answers 4xx without throwing, body included; Windows PowerShell 5.1 throws and the body is read from the response.
  if ($PSVersionTable.PSVersion.Major -ge 7) { $params['SkipHttpErrorCheck'] = $true }
  try {
    $r = Invoke-WebRequest @params
    if ($outFile) { return @{ Status = [int]$r.StatusCode; Body = '' } }
    $body = $r.Content
    if ($body -is [byte[]]) { $body = [System.Text.Encoding]::UTF8.GetString($body) }
    return @{ Status = [int]$r.StatusCode; Body = [string]$body }
  } catch [System.Net.WebException], [System.Net.Http.HttpRequestException], [Microsoft.PowerShell.Commands.HttpResponseException] {
    $resp = $_.Exception.Response
    if ($null -eq $resp) {
      Stop-Pilot 11 "Can't reach $($script:Url) ($($_.Exception.Message)). A private CA: add it to Windows' trusted roots."
    }
    $body = ''
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $body = $_.ErrorDetails.Message }
    elseif ($resp -is [System.Net.HttpWebResponse]) { $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() }
    return @{ Status = [int]$resp.StatusCode; Body = $body }
  }
}

function Get-Reason([string]$body) { if ($body -match '"reason":"([a-z_]+)"') { return $Matches[1] } return '' }

function Test-Health {
  Write-Step "Portal $($script:Url)"
  $r = Invoke-Portal '/connect/v1/health'
  if ($r.Status -ne 200 -or $r.Body -notmatch '"ok":true') {
    Stop-Pilot 11 "$($script:Url) didn't answer like a ClaudePilot portal (HTTP $($r.Status)). Check PILOT_URL."
  }
}

function Test-Url {
  if (-not $script:Url) { Stop-Pilot 10 "Set PILOT_URL to the portal's address (copy the command from the portal)." }
  if ($script:Url -notmatch '^https?://([A-Za-z0-9.:-]+|\[[0-9A-Fa-f:.]+\](:[0-9]+)?)$') { Stop-Pilot 10 "PILOT_URL must be the portal's address alone, like https://pilot.example.com." }
  if ($script:Url -like 'https://*') { return }
  $hostPart = ([System.Uri]$script:Url).Host.Trim('[', ']')
  if ($hostPart -eq 'localhost' -or $hostPart -eq '::1' -or $hostPart -like '127.*') { return }
  if ($env:PILOT_ALLOW_HTTP -ne '1') { Stop-Pilot 10 'Use https: plain http would send the token in the clear.' }
}

function Test-Token {
  if (-not $script:Tok -or $script:Tok -cnotmatch '^cpen_[A-Za-z0-9_-]{43}$') {
    Stop-Pilot 12 "PILOT_TOKEN is missing or isn't a ClaudePilot token. Copy the command again from the portal."
  }
}

# ---------------------------------------------------------------------------------------------------------------------------------
# The plan: KEY=value lines, a fixed allowlist, a strict value pattern; anything else refuses the whole plan.

$script:PlanKeys = @(
  'PILOT_PLAN', 'PILOT_KIND', 'PILOT_ROLE', 'PILOT_TARGET', 'PILOT_NAME', 'PILOT_PLATFORM', 'PILOT_PORTAL', 'PILOT_TUNNEL', 'PILOT_PROTOCOL',
  'PILOT_AGENT_BUILD', 'PILOT_AGENT_URL', 'PILOT_AGENT_SHA256', 'PILOT_NODE_IMAGE', 'PILOT_NODE_VERSION', 'PILOT_WORKSPACE_IMAGE', 'PILOT_IMAGES',
  'PILOT_PTY_PACKAGE', 'PILOT_PTY_INTEGRITY', 'PILOT_PTY_INTEGRITY_LINUX_X64', 'PILOT_PTY_INTEGRITY_LINUX_ARM64', 'PILOT_NAMESPACE',
  'PILOT_STORAGE_CLASS', 'PILOT_STORAGE', 'PILOT_MAX_USES', 'PILOT_EXPIRES', 'PILOT_HOST_ACK', 'PILOT_CA_SHA256', 'PILOT_ALLOW_HTTP'
)

function Read-Plan([string]$text) {
  $lines = @(($text -replace "`r", '') -split "`n" | Where-Object { $_ -ne '' })
  if ($lines.Count -eq 0 -or $lines[0] -cne 'PILOT_PLAN=1') { return $null }
  $values = @{}
  foreach ($line in $lines) {
    if ($line -cnotmatch '^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._:/@,+=-]*)$') { return $null }
    $k = $Matches[1]; $v = $Matches[2]
    if ($script:PlanKeys -ccontains $k -and -not $values.ContainsKey($k)) { $values[$k] = $v }
  }
  return $values
}

function P([string]$key) { if ($script:Plan.ContainsKey($key)) { return $script:Plan[$key] } return '' }

function Get-Plan {
  Write-Step 'Plan'
  $r = Invoke-Portal '/connect/v1/plan' $true
  if ($r.Status -ne 200) {
    $reason = Get-Reason $r.Body
    switch ($r.Status) {
      429 { Stop-Pilot 12 'Too many wrong tokens from this address. Wait ten minutes.' }
      503 { Stop-Pilot 11 "The portal can't take enrollments right now (its store is locked)." }
    }
    if (@(401, 403, 409, 422) -contains $r.Status) {
      switch ($reason) {
        'token_used' { Repair-UsedToken }
        'token_expired' { Stop-Pilot 12 'This command has expired. Make a new one in the portal.' }
        'token_revoked' { Stop-Pilot 12 'This command was revoked in the portal. Make a new one.' }
        'token_invalid' { Stop-Pilot 12 "The portal doesn't know this token. Copy the command again from the portal." }
        default { Stop-Pilot 12 "The portal refused the token (HTTP $($r.Status) $reason)." }
      }
    }
    Stop-Pilot 11 "The portal answered HTTP $($r.Status) for the plan."
  }
  $p = Read-Plan $r.Body
  if ($null -eq $p) { Stop-Pilot 11 "$($script:Url) answered something that isn't a plan. Check PILOT_URL." }
  $script:Plan = $p
  if (@('docker', 'swarm', 'kubernetes', 'container') -notcontains (P 'PILOT_KIND')) {
    if ((P 'PILOT_KIND') -eq 'host') { Stop-Pilot 10 'A Windows host is WSL2: open a WSL2 Linux shell and run the Linux command there.' }
    Stop-Pilot 11 "The plan names a kind this installer doesn't know ($(P 'PILOT_KIND'))."
  }
  if ((P 'PILOT_TARGET') -cnotmatch '^[a-z]([a-z0-9-]*[a-z0-9])?$') { Stop-Pilot 11 "The plan's target id isn't valid." }
  if ((P 'PILOT_AGENT_SHA256') -cnotmatch '^[0-9a-f]{64}$') { Stop-Pilot 11 'The plan has no agent checksum.' }
  if ((P 'PILOT_AGENT_URL') -notmatch '^https?://') { Stop-Pilot 11 'The plan has no agent address.' }
  if (-not (P 'PILOT_NODE_IMAGE')) { Stop-Pilot 11 'The plan names no base image.' }
  if ((P 'PILOT_CA_SHA256')) {
    if (-not $env:PILOT_CA -or -not (Test-Path $env:PILOT_CA)) { Stop-Pilot 10 'This portal uses a private CA: set PILOT_CA to its certificate.' }
    if ((Get-FileHash $env:PILOT_CA -Algorithm SHA256).Hash.ToLower() -ne (P 'PILOT_CA_SHA256')) { Stop-Pilot 10 "PILOT_CA isn't the certificate this portal uses." }
  }
  Write-Say "Target $(P 'PILOT_TARGET') ($(P 'PILOT_KIND'), $(P 'PILOT_ROLE')), agent build $(P 'PILOT_AGENT_BUILD')"
}

function Repair-UsedToken {
  $r = Invoke-Portal '/connect/v1/enroll/status' $true
  if ($r.Status -eq 200 -and $r.Body -match '"target":"([a-z0-9-]+)"') {
    $found = @(Find-Installs $Matches[1])
    if ($found.Count -eq 1) {
      Write-Say "This token was used already; $($found[0]) is installed here. Checking that it runs."
      $name = $found[0].Split(':')[1]
      if ($found[0] -like 'docker:*' -or $found[0] -like 'container:*') {
        if ((Get-Native @('docker', 'container', 'inspect', '-f', '{{.State.Status}}', $name)) -ne 'running') { [void](Invoke-Native @('docker', 'start', $name)) }
      }
      Wait-Connected
    }
  }
  Stop-Pilot 12 'This command was used already. Make a new one in the portal.'
}

function Wait-Connected {
  if ($script:Dry) { Complete-Pilot 0 'dry-run' }
  if ($env:PILOT_NO_WAIT -eq '1' -or -not $script:Tok) { Complete-Pilot 0 'installed' }
  Write-Step "Waiting for the portal to see it connected (up to $($script:WaitS)s)"
  $deadline = (Get-Date).AddSeconds($script:WaitS)
  while ((Get-Date) -lt $deadline) {
    $r = Invoke-Portal '/connect/v1/enroll/status' $true
    if ($r.Status -eq 200 -and $r.Body -match '"state":"([a-z]+)"') {
      if ($Matches[1] -eq 'connected') { Write-Say 'Connected.'; Complete-Pilot 0 'connected' }
      if ($Matches[1] -eq 'revoked') { Stop-Pilot 15 'The token was revoked while waiting.' }
    }
    Start-Sleep -Seconds $script:PollS
  }
  Stop-Pilot 15 "Installed, but the portal doesn't see it connected after $($script:WaitS)s."
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Docker (Docker Desktop, Linux containers; the socket is /var/run/docker.sock in its Linux VM)

$script:DArch = ''
function Test-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Pilot 10 "Docker isn't installed here (no docker command)." }
  $v = Get-Native @('docker', 'version', '--format', '{{.Server.Version}}')
  if (-not $v) { Stop-Pilot 10 "Docker isn't running here (start Docker Desktop)." }
  $os = Get-Native @('docker', 'info', '--format', '{{.OSType}}')
  if ($os -ne 'linux') { Stop-Pilot 10 'Docker runs Windows containers: switch Docker Desktop to Linux containers.' }
  $arch = Get-Native @('docker', 'version', '--format', '{{.Server.Arch}}')
  switch ($arch) { 'amd64' { $script:DArch = 'x64' } 'arm64' { $script:DArch = 'arm64' } default { Stop-Pilot 10 "Docker runs on $arch." } }
  Write-Say "Docker $v ($($script:DArch))"
}

function Initialize-Image([string]$ref) {
  if (Get-Native @('docker', 'image', 'inspect', '--format', '{{.Id}}', $ref)) { Write-Say "Image $ref is here."; return }
  if ((Invoke-Native @('docker', 'pull', $ref)) -ne 0) { Stop-Pilot 13 "Couldn't pull $ref." }
}

function Initialize-WorkspaceImage {
  $img = P 'PILOT_WORKSPACE_IMAGE'
  if ($env:PILOT_BUILD_IMAGE -ne '1') {
    if (Get-Native @('docker', 'image', 'inspect', '--format', '{{.Id}}', $img)) { Write-Say "Image $img is here."; return }
    if ((Invoke-Native @('docker', 'pull', $img)) -eq 0) { return }
    if ($env:PILOT_BUILD_IMAGE -eq '0') { Stop-Pilot 13 "Couldn't pull $img." }
    Write-Say "Couldn't pull $($img): building it from the portal's build context."
  }
  Write-Step "Building $img from the portal's build context"
  $dir = Join-Path $script:Tmp 'context'
  if (-not $script:Dry) {
    $tgz = Join-Path $script:Tmp 'context.tgz'
    $r = Invoke-Portal '/connect/v1/image/workspace/context.tgz' $false $tgz
    if ($r.Status -ne 200) { Stop-Pilot 13 "The portal answered HTTP $($r.Status) for the image's build context." }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    & tar -xzf $tgz -C $dir
    if ($LASTEXITCODE -ne 0) { Stop-Pilot 14 'Unpacking the build context failed.' }
  }
  if ((Invoke-Native @('docker', 'build', '-t', $img, $dir)) -ne 0) { Stop-Pilot 14 "Building $img failed." }
}

function Get-ProxyArgs { $a = @(); foreach ($n in 'HTTPS_PROXY', 'NO_PROXY') { if ([Environment]::GetEnvironmentVariable($n)) { $a += @('-e', $n) } }; return $a }

# Writes text into a volume through the node image (stdin; LF endings).
function Write-VolumeFile([string]$mount, [string]$path, [string]$text, [string]$note, [bool]$secret = $false) {
  $env:PILOT_DEST = $path
  $a = @('docker', 'run', '--rm', '-i', '-v', $mount, '-e', 'PILOT_DEST', '--entrypoint', 'sh', (P 'PILOT_NODE_IMAGE'), '-c', 'umask 077; mkdir -p $(dirname $PILOT_DEST) && tr -d \\r > $PILOT_DEST')
  $rc = Invoke-Native $a ($text -replace "`r", '') $note
  Remove-Item Env:PILOT_DEST
  if ($rc -ne 0) { Stop-Pilot 14 "Couldn't write $path." }
}

function Invoke-Fetch([string[]]$mounts, [string]$url, [string]$sum, [string]$out) {
  $env:PILOT_FETCHER = $script:Fetcher
  $a = @('docker', 'run', '--rm') + $mounts + @('-e', 'PILOT_FETCHER', '-e', 'NODE_USE_ENV_PROXY=1') + (Get-ProxyArgs)
  if ($env:PILOT_CA) { $a += @('-e', "NODE_EXTRA_CA_CERTS=$($script:CData)/ca.pem") }
  if ($script:Hdrs) { $a += @('-e', "PILOT_HEADERS_FILE=$($script:CData)/headers") }
  $a += @((P 'PILOT_NODE_IMAGE'), 'node', '-e', 'eval(process.env.PILOT_FETCHER)', $url, $sum, $out)
  $rc = Invoke-Native $a
  Remove-Item Env:PILOT_FETCHER
  if ($rc -ne 0) { Stop-Pilot 13 "Downloading or checking $(Split-Path $out -Leaf) failed." }
}

function Write-Secrets([string]$mount) {
  if ($env:PILOT_CA) { Write-VolumeFile $mount "$($script:CData)/ca.pem" (Get-Content -Raw $env:PILOT_CA) 'the CA certificate' }
  if ($script:Hdrs) { Write-VolumeFile $mount "$($script:CData)/headers" $script:Hdrs 'the extra headers' $true }
}

function Get-AgentJson([string]$mode, [string]$extra = '') {
  $name = P 'PILOT_NAME'
  if (-not $name) { $name = ($env:COMPUTERNAME -replace '[^A-Za-z0-9.-]', '-').ToLower() }
  $images = ''
  if (P 'PILOT_IMAGES') { $images = ((P 'PILOT_IMAGES').Split(',') | ForEach-Object { '"' + $_ + '"' }) -join ',' }
  $j = "{`n  `"url`": `"$(P 'PILOT_PORTAL')`",`n  `"mode`": `"$mode`",`n  `"nodeName`": `"$name`",`n  `"images`": [$images]"
  if ((P 'PILOT_PORTAL') -like 'http://*') { $j += ",`n  `"allowHttp`": true" }
  if ($env:PILOT_CA) { $j += ",`n  `"ca`": `"$($script:CData)/ca.pem`"" }
  if ($extra) { $j += ",`n  $extra" }
  return "$j`n}`n"
}

function Set-CurrentLink([string]$mount, [string]$dir) {
  $env:PILOT_DIR = $dir; $env:PILOT_BUILD = P 'PILOT_AGENT_BUILD'
  $a = @('docker', 'run', '--rm', '-v', $mount, '-e', 'PILOT_DIR', '-e', 'PILOT_BUILD', '--entrypoint', 'sh', (P 'PILOT_NODE_IMAGE'), '-c', 'ln -sfn bundle/$PILOT_BUILD/agent.mjs $PILOT_DIR/current.mjs')
  $rc = Invoke-Native $a
  Remove-Item Env:PILOT_DIR, Env:PILOT_BUILD
  if ($rc -ne 0) { Stop-Pilot 14 "Couldn't point $dir/current.mjs at the new build." }
}

function Invoke-Enroll([string[]]$mounts, [string]$bundle) {
  Write-Step 'Enrolling'
  $a = @('docker', 'run', '--rm', '-i') + $mounts + @('-e', "PILOT_DATA_DIR=$($script:CData)", '-e', 'NODE_USE_ENV_PROXY=1') + (Get-ProxyArgs)
  if ($env:PILOT_CA) { $a += @('-e', "NODE_EXTRA_CA_CERTS=$($script:CData)/ca.pem") }
  $a += @((P 'PILOT_NODE_IMAGE'), 'node', $bundle, 'enroll', '--token-stdin')
  $rc = Invoke-Native $a $script:Tok 'the token'
  switch ($rc) { 0 { return } 11 { Stop-Pilot 11 "The agent couldn't reach the portal to enroll." } 12 { Stop-Pilot 12 'The portal refused the enrollment.' } default { Stop-Pilot 14 "Enrolling failed (exit $rc)." } }
}

function Install-Docker {
  Test-Docker
  $t = P 'PILOT_TARGET'; $name = "claudepilot-agent-$t"; $mount = "$($name):$($script:CData)"
  Write-Step 'Images'
  Initialize-Image (P 'PILOT_NODE_IMAGE')
  Initialize-WorkspaceImage
  Write-Step "Agent bundle $(P 'PILOT_AGENT_BUILD') (sha256 checked before it runs)"
  Write-Secrets $mount
  Invoke-Fetch @('-v', $mount) (P 'PILOT_AGENT_URL') (P 'PILOT_AGENT_SHA256') "$($script:CData)/bundle/$(P 'PILOT_AGENT_BUILD')/agent.mjs"
  Write-VolumeFile $mount "$($script:CData)/agent.json" (Get-AgentJson 'docker' '"dockerSocket": "/var/run/docker.sock"') 'agent.json'
  Set-CurrentLink $mount $script:CData
  Invoke-Enroll @('-v', $mount) "$($script:CData)/current.mjs"
  Write-Step "Agent container $name"
  $state = Get-Native @('docker', 'container', 'inspect', '-f', '{{.State.Status}}', $name)
  if ($state) {
    $verb = 'restart'; if ($state -ne 'running') { $verb = 'start' }
    [void](Invoke-Native @('docker', $verb, $name))
  } else {
    $a = @('docker', 'run', '-d', '--name', $name, '--restart', 'unless-stopped', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '256', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', $mount,
      '--label', 'claudepilot.connect=agent', '--label', "claudepilot.connect.target=$t", '--label', 'claudepilot.connect.kind=docker',
      '-e', "PILOT_DATA_DIR=$($script:CData)", '-e', 'NODE_USE_ENV_PROXY=1') + (Get-ProxyArgs)
    if ($env:PILOT_CA) { $a += @('-e', "NODE_EXTRA_CA_CERTS=$($script:CData)/ca.pem") }
    $a += @((P 'PILOT_NODE_IMAGE'), 'node', "$($script:CData)/current.mjs", 'run')
    if ((Invoke-Native $a) -ne 0) { Stop-Pilot 14 "Starting $name failed." }
  }
  Wait-Connected
}

function Install-Container {
  Test-Docker
  $t = P 'PILOT_TARGET'; $name = "claudepilot-$t"
  $av = "$($name)-agent:$($script:CAgent)"; $sv = "$($name)-state:$($script:CData)"
  $pi = P "PILOT_PTY_INTEGRITY_LINUX_$($script:DArch.ToUpper())"
  if (-not (P 'PILOT_PTY_PACKAGE') -or -not (P 'PILOT_PTY_INTEGRITY') -or -not $pi) { Stop-Pilot 11 "The plan has no pty package for linux-$($script:DArch)." }
  $ver = (P 'PILOT_PTY_PACKAGE').Split('@')[-1]
  $reg = 'https://registry.npmjs.org'; if ($env:npm_config_registry) { $reg = $env:npm_config_registry.TrimEnd('/') }
  $arch = $script:DArch
  Write-Step 'Images'
  Initialize-Image (P 'PILOT_NODE_IMAGE')
  Initialize-WorkspaceImage
  Write-Step "Agent bundle $(P 'PILOT_AGENT_BUILD') and the pty package (checked before use)"
  Write-Secrets $sv
  $m = @('-v', $av, '-v', $sv)
  Invoke-Fetch $m (P 'PILOT_AGENT_URL') (P 'PILOT_AGENT_SHA256') "$($script:CAgent)/bundle/$(P 'PILOT_AGENT_BUILD')/agent.mjs"
  Invoke-Fetch $m "$reg/@lydell/node-pty/-/node-pty-$ver.tgz" (P 'PILOT_PTY_INTEGRITY') "$($script:CAgent)/cache/node-pty-$ver.tgz"
  Invoke-Fetch $m "$reg/@lydell/node-pty-linux-$arch/-/node-pty-linux-$arch-$ver.tgz" $pi "$($script:CAgent)/cache/node-pty-linux-$arch-$ver.tgz"
  $env:PILOT_VER = $ver; $env:PILOT_ARCH = $arch
  $unpack = 'set -e; m=/opt/claudepilot-agent/node_modules/@lydell; c=/opt/claudepilot-agent/cache; rm -rf $m/node-pty $m/node-pty-linux-$PILOT_ARCH; mkdir -p $m/node-pty $m/node-pty-linux-$PILOT_ARCH; tar -xzf $c/node-pty-$PILOT_VER.tgz -C $m/node-pty --strip-components=1 --no-same-owner; tar -xzf $c/node-pty-linux-$PILOT_ARCH-$PILOT_VER.tgz -C $m/node-pty-linux-$PILOT_ARCH --strip-components=1 --no-same-owner'
  $rc = Invoke-Native @('docker', 'run', '--rm', '-v', $av, '-e', 'PILOT_VER', '-e', 'PILOT_ARCH', '--entrypoint', 'sh', (P 'PILOT_NODE_IMAGE'), '-c', $unpack)
  Remove-Item Env:PILOT_VER, Env:PILOT_ARCH
  if ($rc -ne 0) { Stop-Pilot 14 'Unpacking the pty package failed.' }
  Write-VolumeFile $sv "$($script:CData)/agent.json" (Get-AgentJson 'container') 'agent.json'
  Set-CurrentLink $av $script:CAgent
  Invoke-Enroll @('-v', $sv, '-v', "$($av):ro") "$($script:CAgent)/current.mjs"
  Write-Step "Workspace container $name"
  $state = Get-Native @('docker', 'container', 'inspect', '-f', '{{.State.Status}}', $name)
  if ($state) {
    $verb = 'restart'; if ($state -ne 'running') { $verb = 'start' }
    [void](Invoke-Native @('docker', $verb, $name))
  } else {
    $a = @('docker', 'run', '-d', '--name', $name, '--hostname', $t, '--init', '--user', '0:0', '--restart', 'unless-stopped',
      '-v', "$($name)-home:/home/node", '-v', "$($av):ro", '-v', $sv,
      '--label', 'claudepilot.connect=single', '--label', "claudepilot.connect.target=$t", '--label', 'claudepilot.connect.kind=container',
      '-e', "PILOT_DATA_DIR=$($script:CData)", '-e', 'NODE_USE_ENV_PROXY=1') + (Get-ProxyArgs)
    if ($env:PILOT_CA) { $a += @('-e', "NODE_EXTRA_CA_CERTS=$($script:CData)/ca.pem") }
    $a += @((P 'PILOT_WORKSPACE_IMAGE'), 'node', "$($script:CAgent)/current.mjs", 'run')
    if ((Invoke-Native $a) -ne 0) { Stop-Pilot 14 "Starting $name failed." }
  }
  Wait-Connected
}

function Install-Swarm {
  Test-Docker
  $sw = Get-Native @('docker', 'info', '--format', '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}')
  if ($sw -ne 'active true') { Stop-Pilot 10 "This isn't a swarm manager ($sw). Run it on a manager." }
  $t = P 'PILOT_TARGET'; $name = "claudepilot-agent-$t"
  if (Get-Native @('docker', 'service', 'inspect', '--format', '{{.ID}}', $name)) { Write-Say "Service $name exists already."; Wait-Connected }
  # The one exception (PRD section 10.1): the token sits in the service's environment while the nodes enroll; through a file, then removed.
  $envFile = Join-Path $script:Tmp 'service.env'
  [System.IO.File]::WriteAllText($envFile, "PILOT_ENROLL_TOKEN=$($script:Tok)`nPILOT_FETCHER=$($script:Fetcher)`n")
  $a = @('docker', 'service', 'create', '--detach', '--mode', 'global', '--name', $name, '--env-file', $envFile,
    '--env', "PILOT_URL=$(P 'PILOT_PORTAL')", '--env', 'PILOT_MODE=swarm', '--env', "PILOT_DATA_DIR=$($script:CData)", '--env', "PILOT_IMAGES=$(P 'PILOT_IMAGES')",
    '--env', "PILOT_BUNDLE_URL=$(P 'PILOT_AGENT_URL')", '--env', "PILOT_BUNDLE_SHA256=$(P 'PILOT_AGENT_SHA256')", '--env', 'NODE_USE_ENV_PROXY=1',
    '--env', 'PILOT_NODE_NAME={{.Node.Hostname}}')
  if ((P 'PILOT_PORTAL') -like 'http://*') { $a += @('--env', 'PILOT_ALLOW_HTTP=1') }
  $a += @('--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock', '--mount', "type=volume,src=$name,dst=$($script:CData)",
    '--mount', 'type=tmpfs,dst=/tmp', '--read-only', '--cap-drop', 'ALL', '--limit-memory', '256M', '--restart-condition', 'any',
    '--label', 'claudepilot.connect=agent', '--label', "claudepilot.connect.target=$t", '--label', 'claudepilot.connect.kind=swarm',
    '--container-label', 'claudepilot.connect=agent', (P 'PILOT_NODE_IMAGE'), 'sh', '-c',
    'node -e ''eval(process.env.PILOT_FETCHER)'' $PILOT_BUNDLE_URL $PILOT_BUNDLE_SHA256 $PILOT_DATA_DIR/agent.mjs && exec node $PILOT_DATA_DIR/agent.mjs run')
  Write-Step "Service $name"
  $rc = Invoke-Native $a
  Remove-Item $envFile -Force -ErrorAction SilentlyContinue
  if ($rc -ne 0) { Stop-Pilot 14 'Creating the service failed.' }
  if ($script:Dry) { Complete-Pilot 0 'dry-run' }
  try { Wait-Connected } catch [PilotExit] { if ($_.Exception.Code -ne 0) { throw } }
  Start-Sleep -Seconds 15
  [void](Invoke-Native @('docker', 'service', 'update', '--detach', '--env-rm', 'PILOT_ENROLL_TOKEN', $name))
  Complete-Pilot 0 'connected'
}

# ---------------------------------------------------------------------------------------------------------------------------------
# Kubernetes (the cluster is shown and confirmed first)

$script:Ctx = ''
function Get-KubeContext {
  if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { Stop-Pilot 10 "kubectl isn't installed here." }
  $script:Ctx = $env:PILOT_KUBE_CONTEXT
  if (-not $script:Ctx) { $script:Ctx = Get-Native @('kubectl', 'config', 'current-context') }
  if (-not $script:Ctx) { Stop-Pilot 10 'kubectl has no current context. Set PILOT_KUBE_CONTEXT.' }
  $server = Get-Native @('kubectl', 'config', 'view', '--minify', '--context', $script:Ctx, '-o', 'jsonpath={.clusters[0].cluster.server}')
  Write-Say "kubectl context: $($script:Ctx)"
  Write-Say "API server:      $server"
}

function Install-Kubernetes {
  Get-KubeContext
  $ns = P 'PILOT_NAMESPACE'; if (-not $ns) { $ns = 'claudepilot-workspaces' }
  Write-Say "Namespace:       $ns"
  Confirm-Pilot 'Apply the ClaudePilot agent to this cluster?'
  $nsExists = [bool](Get-Native @('kubectl', '--context', $script:Ctx, 'get', 'namespace', $ns, '-o', 'name'))
  Write-Step 'Checking your rights (kubectl auth can-i)'
  $missing = @()
  $checks = @('serviceaccounts', 'roles.rbac.authorization.k8s.io', 'rolebindings.rbac.authorization.k8s.io', 'secrets', 'deployments.apps', 'configmaps')
  foreach ($res in $checks) {
    $ans = Get-Native @('kubectl', '--context', $script:Ctx, 'auth', 'can-i', 'create', $res, '-n', $ns)
    Write-Say "  create $($res): $ans"
    if ($ans -ne 'yes') { $missing += "create $res" }
  }
  if (-not $nsExists -and (Get-Native @('kubectl', '--context', $script:Ctx, 'auth', 'can-i', 'create', 'namespaces')) -ne 'yes') { $missing += 'create namespaces' }
  if ($missing.Count) { Stop-Pilot 10 "Your kubectl user can't $($missing -join ', ') in $ns." }
  Write-Step 'Manifest'
  $r = Invoke-Portal '/connect/v1/manifest' $true
  if ($r.Status -ne 200) { Stop-Pilot 11 "The portal answered HTTP $($r.Status) for the manifest." }
  $yaml = $r.Body -replace "`r", ''
  if ($nsExists) { $yaml = $yaml.Substring($yaml.IndexOf("`n---`n") + 5) }
  if ((Invoke-Native @('kubectl', '--context', $script:Ctx, 'apply', '-f', '-') $yaml 'the manifest') -ne 0) { Stop-Pilot 14 'kubectl apply failed.' }
  if ((Invoke-Native @('kubectl', '--context', $script:Ctx, '-n', $ns, 'rollout', 'status', 'deployment/claudepilot-agent', '--timeout=120s')) -ne 0) {
    Stop-Pilot 14 "The agent's Deployment didn't roll out."
  }
  Wait-Connected
}

# ---------------------------------------------------------------------------------------------------------------------------------
# What is installed here; upgrade, uninstall, status, doctor

function Find-Installs([string]$target = $env:PILOT_TARGET) {
  $kind = $env:PILOT_KIND
  $found = @()
  if ((Get-Command docker -ErrorAction SilentlyContinue) -and (Get-Native @('docker', 'version', '--format', '{{.Server.Version}}'))) {
    $filter = 'label=claudepilot.connect.target'; if ($target) { $filter += "=$target" }
    if (-not $kind -or $kind -eq 'docker' -or $kind -eq 'container') {
      $rows = Get-Native @('docker', 'ps', '-a', '--filter', $filter, '--format', '{{.Label "claudepilot.connect.kind"}}:{{.Names}}')
      if ($rows) { foreach ($row in ($rows -split "`n")) { if ($row -match '^(docker|container):' -and (-not $kind -or $row -like "$($kind):*")) { $found += $row.Trim() } } }
    }
    if (-not $kind -or $kind -eq 'swarm') {
      $rows = Get-Native @('docker', 'service', 'ls', '--filter', $filter, '--format', '{{.Name}}')
      if ($rows) { foreach ($row in ($rows -split "`n")) { $found += "swarm:$($row.Trim())" } }
    }
  }
  if ($kind -eq 'kubernetes') {
    Get-KubeContext
    $sel = 'app.kubernetes.io/part-of=claudepilot-connect'; if ($target) { $sel += ",claudepilot.connect/target=$target" }
    $rows = Get-Native @('kubectl', '--context', $script:Ctx, 'get', 'deployments', '-A', '-l', $sel, '-o', 'jsonpath={range .items[*]}{.metadata.namespace}{"\n"}{end}')
    if ($rows) { foreach ($row in ($rows -split "`n")) { if ($row.Trim()) { $found += "kubernetes:$($row.Trim())" } } }
  }
  return , $found
}

function Get-OneInstall {
  $found = @(Find-Installs)
  if ($found.Count -eq 0) { Stop-Pilot 10 "Nothing of ClaudePilot's is installed here." }
  if ($found.Count -gt 1) { Write-Say "Installed here: $($found -join ' ')"; Stop-Pilot 10 'More than one install: set PILOT_TARGET (and PILOT_KIND).' }
  return $found[0]
}

function Invoke-Upgrade {
  $one = Get-OneInstall
  $kind, $name = $one.Split(':', 2)
  if (-not $script:Url) { Stop-Pilot 10 'Set PILOT_URL to the portal address.' }
  Test-Url
  Test-Health
  $r = Invoke-Portal '/connect/v1/agent/latest.json'
  if ($r.Status -ne 200) { Stop-Pilot 11 "The portal answered HTTP $($r.Status) for latest.json." }
  $latest = $r.Body | ConvertFrom-Json
  $agentUrl = [string]$latest.url; if ($agentUrl -notmatch '^https?://') { $agentUrl = "$($script:Url)$agentUrl" }
  $script:Plan = @{ PILOT_AGENT_BUILD = [string]$latest.build; PILOT_AGENT_SHA256 = [string]$latest.sha256; PILOT_NODE_IMAGE = 'node:22-bookworm-slim' }
  if ($env:PILOT_NODE_IMAGE) { $script:Plan['PILOT_NODE_IMAGE'] = $env:PILOT_NODE_IMAGE }
  Write-Step "Upgrading $one to build $($latest.build)"
  switch ($kind) {
    'docker' {
      $script:Plan['PILOT_NODE_IMAGE'] = Get-Native @('docker', 'container', 'inspect', '-f', '{{.Config.Image}}', $name)
      $mount = "$($name):$($script:CData)"
      Invoke-Fetch @('-v', $mount) $agentUrl $latest.sha256 "$($script:CData)/bundle/$($latest.build)/agent.mjs"
      Set-CurrentLink $mount $script:CData
      [void](Invoke-Native @('docker', 'restart', $name))
    }
    'container' {
      $av = "$($name)-agent:$($script:CAgent)"
      Invoke-Fetch @('-v', $av, '-v', "$($name)-state:$($script:CData)") $agentUrl $latest.sha256 "$($script:CAgent)/bundle/$($latest.build)/agent.mjs"
      Set-CurrentLink $av $script:CAgent
      [void](Invoke-Native @('docker', 'restart', $name))
    }
    'swarm' { [void](Invoke-Native @('docker', 'service', 'update', '--detach', '--env-add', "PILOT_BUNDLE_URL=$agentUrl", '--env-add', "PILOT_BUNDLE_SHA256=$($latest.sha256)", '--force', $name)) }
    'kubernetes' {
      Confirm-Pilot "Upgrade the agent in $name on context $($script:Ctx)?"
      foreach ($c in 'fetch', 'agent') { [void](Invoke-Native @('kubectl', '--context', $script:Ctx, '-n', $name, 'set', 'env', 'deployment/claudepilot-agent', '-c', $c, "PILOT_BUNDLE_URL=$agentUrl", "PILOT_BUNDLE_SHA256=$($latest.sha256)")) }
    }
  }
  if ($script:Dry) { Complete-Pilot 0 'dry-run' }
  Complete-Pilot 0 'installed'
}

function Invoke-Uninstall {
  $one = Get-OneInstall
  $kind, $name = $one.Split(':', 2)
  Write-Step "Uninstall $one"
  switch ($kind) {
    'docker' {
      Write-Say "Removes: container $name$(if ($script:Purge) { " and volume $name" }). Workspaces stay."
      Confirm-Pilot 'Remove it?'
      [void](Invoke-Native @('docker', 'rm', '-f', $name))
      if ($script:Purge) { [void](Invoke-Native @('docker', 'volume', 'rm', $name)) }
    }
    'container' {
      if ($script:Purge) { Write-Say "Removes: container $name and volumes $name-home (its files are LOST), $name-agent, $name-state." }
      else { Write-Say "Removes: container $name. Its volumes stay (--purge removes them)." }
      Confirm-Pilot 'Remove it?'
      [void](Invoke-Native @('docker', 'rm', '-f', $name))
      if ($script:Purge) { foreach ($v in "$name-home", "$name-agent", "$name-state") { [void](Invoke-Native @('docker', 'volume', 'rm', $v)) } }
    }
    'swarm' {
      Write-Say "Removes: service $name. Workspaces stay."
      Confirm-Pilot 'Remove it?'
      [void](Invoke-Native @('docker', 'service', 'rm', $name))
    }
    'kubernetes' {
      Write-Say "Removes from $name on context $($script:Ctx): the agent's Deployment, ServiceAccount, Role, RoleBinding, Secrets and ConfigMap. The namespace and workspaces stay."
      Confirm-Pilot 'Remove it?'
      $sel = 'app.kubernetes.io/part-of=claudepilot-connect'; if ($env:PILOT_TARGET) { $sel += ",claudepilot.connect/target=$($env:PILOT_TARGET)" }
      [void](Invoke-Native @('kubectl', '--context', $script:Ctx, '-n', $name, 'delete', 'deployment,serviceaccount,role,rolebinding,secret,configmap', '-l', $sel, '--ignore-not-found'))
      [void](Invoke-Native @('kubectl', '--context', $script:Ctx, '-n', $name, 'delete', 'secret', 'claudepilot-agent-identity', '--ignore-not-found'))
    }
  }
  Write-Say 'Remove the target in the portal too (Targets > the target > Remove).'
  if ($script:Dry) { Complete-Pilot 0 'dry-run' }
  Complete-Pilot 0 'removed'
}

function Invoke-Status([bool]$doctor) {
  $found = @(Find-Installs)
  if ($found.Count -eq 0) { Write-Say "Nothing of ClaudePilot's is installed here."; Complete-Pilot 0 'ok' }
  $bad = $false
  foreach ($one in $found) {
    $kind, $name = $one.Split(':', 2)
    if ($kind -eq 'docker' -or $kind -eq 'container') {
      Write-Say "$($one): $(Get-Native @('docker', 'container', 'inspect', '-f', '{{.State.Status}}', $name))"
      if ($doctor) {
        $bundle = "$($script:CData)/current.mjs"; if ($kind -eq 'container') { $bundle = "$($script:CAgent)/current.mjs" }
        & docker exec $name node $bundle doctor | Out-Host
        if ($LASTEXITCODE -ne 0) { $bad = $true }
      }
    } else { Write-Say $one }
  }
  if ($bad) { Complete-Pilot 14 'failed' }
  Complete-Pilot 0 'ok'
}

function Invoke-PilotMain([string[]]$argv) {
  $cmd = 'install'
  foreach ($a in $argv) {
    switch ($a) {
      { @('install', 'upgrade', 'uninstall', 'doctor', 'status') -contains $_ } { $cmd = $_; break }
      '--purge' { $script:Purge = $true; break }
      { $_ -eq '--yes' -or $_ -eq '-y' } { $script:Yes = $true; break }
      '--dry-run' { $script:Dry = $true; break }
      default { Stop-Pilot 10 "Unknown argument: $a" }
    }
  }
  $script:Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('pilot-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $script:Tmp | Out-Null
  if ($script:Dry) { Write-Say 'Dry run: nothing will be changed.' }
  switch ($cmd) {
    'upgrade' { Invoke-Upgrade }
    'uninstall' { Invoke-Uninstall }
    'status' { Invoke-Status $false }
    'doctor' { Invoke-Status $true }
  }
  Test-Url
  Test-Token
  Test-Health
  Get-Plan
  switch (P 'PILOT_KIND') {
    'docker' { Install-Docker }
    'container' { Install-Container }
    'swarm' { Install-Swarm }
    'kubernetes' { Install-Kubernetes }
  }
  Stop-Pilot 14 'Nothing was done.'
}

$pilotCode = 0
$pilotResult = 'failed'
try {
  Invoke-PilotMain $args
} catch [PilotExit] {
  $pilotCode = $_.Exception.Code
  $pilotResult = $_.Exception.Result
  if ($_.Exception.Message) { Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red }
} catch {
  $pilotCode = 14
  Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  if ($script:Tmp -and (Test-Path $script:Tmp)) { Remove-Item -Recurse -Force $script:Tmp -ErrorAction SilentlyContinue }
  $script:Tok = $null
}
Write-Output "PILOT_RESULT=$pilotResult"
$global:LASTEXITCODE = $pilotCode
if ($PSCommandPath) { exit $pilotCode }
