#!/bin/bash
# Exercises `omarchy-hcloud-bridge sync-ssh` against throwaway HOMEs. The thing
# under test edits ~/.ssh/config, so every case runs in its own sandbox and the
# real one is never in reach.

set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE="$ROOT/bin/omarchy-hcloud-bridge"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

checks=0
failures=0

check() {
  local message="$1" condition="$2"
  checks=$((checks + 1))
  if [[ $condition != "yes" ]]; then
    failures=$((failures + 1))
    echo "FAIL  $message"
  fi
}

contains() { [[ $1 == *"$2"* ]] && echo yes || echo no; }

sandbox() { local name="$1"; mkdir -p "$WORK/$name/.ssh"; echo "$WORK/$name"; }

sync() { HOME="$1" "$BRIDGE" sync-ssh; }

JOB='{"user":"root","key":"~/.ssh/id_ed25519","hosts":[{"alias":"prod/web-1","ip":"203.0.113.10"},{"alias":"prod/db-1","ip":"203.0.113.11"}]}'

# --- a fresh machine with no ssh config at all -------------------------------
H="$(sandbox fresh)"
out=$(echo "$JOB" | sync "$H")
check "a missing ssh config is created" "$(contains "$out" '"changed": true')"
check "both hosts are written" "$(contains "$out" '"hosts": 2')"
check "the block is present" "$(contains "$(cat "$H/.ssh/config")" 'Host prod/web-1')"
check "the config is chmod 600" "$([[ $(stat -c %a "$H/.ssh/config") == 600 ]] && echo yes || echo no)"
check "nothing is backed up when there was nothing to lose" \
  "$([[ ! -e $H/.ssh/config.hcloud-sync.bak ]] && echo yes || echo no)"

# --- the refresh cycle runs this every minute; it must settle ----------------
out=$(echo "$JOB" | sync "$H")
check "an unchanged fleet rewrites nothing" "$(contains "$out" '"changed": false')"
check "an unchanged fleet does not roll the backup" \
  "$([[ ! -e $H/.ssh/config.hcloud-sync.bak ]] && echo yes || echo no)"

# --- an existing hand-written config -----------------------------------------
H="$(sandbox existing)"
printf 'Host github.com\n    User git\n\nHost *\n    ServerAliveInterval 60\n' > "$H/.ssh/config"
echo "$JOB" | sync "$H" > /dev/null
config=$(cat "$H/.ssh/config")
check "hand-written entries survive the first sync" "$(contains "$config" 'Host github.com')"
check "the managed block is appended" "$(contains "$config" '# --- hcloud-sync START ---')"
check "the previous config is backed up" \
  "$([[ -f $H/.ssh/config.hcloud-sync.bak ]] && echo yes || echo no)"

# --- a server changed address ------------------------------------------------
echo '{"user":"deploy","key":"~/.ssh/k","hosts":[{"alias":"prod/web-1","ip":"198.51.100.7"}]}' | sync "$H" > /dev/null
config=$(cat "$H/.ssh/config")
check "the new address replaces the old one" "$(contains "$config" 'HostName 198.51.100.7')"
check "the old address is gone" "$([[ $config != *"203.0.113.10"* ]] && echo yes || echo no)"
check "a departed server is dropped" "$([[ $config != *"prod/db-1"* ]] && echo yes || echo no)"
check "hand-written entries still survive" "$(contains "$config" 'Host github.com')"

# --- the block sits between other entries ------------------------------------
H="$(sandbox middle)"
printf 'Host before\n    User one\n\n# --- hcloud-sync START ---\nHost stale\n# --- hcloud-sync END ---\n\nHost after\n    User two\n' > "$H/.ssh/config"
echo "$JOB" | sync "$H" > /dev/null
config=$(cat "$H/.ssh/config")
check "entries before the block survive" "$(contains "$config" 'Host before')"
check "entries after the block survive" "$(contains "$config" 'Host after')"
check "the stale block content is replaced" "$([[ $config != *"Host stale"* ]] && echo yes || echo no)"

# --- someone half-deleted the block by hand ----------------------------------
H="$(sandbox unterminated)"
printf 'Host keep\n    User me\n\n# --- hcloud-sync START ---\nHost oops\n' > "$H/.ssh/config"
before=$(md5sum < "$H/.ssh/config")
out=$(echo "$JOB" | sync "$H")
check "an unterminated block is refused" "$(contains "$out" '"ok": false')"
check "an unterminated block leaves the file alone" \
  "$([[ $(md5sum < "$H/.ssh/config") == "$before" ]] && echo yes || echo no)"

# --- incomplete servers ------------------------------------------------------
H="$(sandbox partial)"
out=$(echo '{"user":"root","key":"","hosts":[{"alias":"a/b","ip":""},{"alias":"","ip":"1.1.1.1"},{"alias":"c/d","ip":"5.6.7.8"}]}' | sync "$H")
check "a server with no IPv4 is skipped" "$(contains "$out" '"hosts": 1')"
check "IdentityFile is omitted when no key is configured" \
  "$([[ $(cat "$H/.ssh/config") != *"IdentityFile"* ]] && echo yes || echo no)"

# --- a config that is a symlink into a dotfiles checkout --------------------
H="$(sandbox linked)"
mkdir -p "$H/dotfiles"
printf 'Host keep\n    HostName 10.0.0.1\n' > "$H/dotfiles/ssh_config"
ln -s "$H/dotfiles/ssh_config" "$H/.ssh/config"
out=$(echo "$JOB" | sync "$H")
check "a symlinked config is written through" "$(contains "$out" '"changed": true')"
check "the link itself survives" "$([[ -L $H/.ssh/config ]] && echo yes || echo no)"
check "the target carries the block" "$(contains "$(cat "$H/dotfiles/ssh_config")" 'Host prod/web-1')"
check "and the hand-written entry beside it" "$(contains "$(cat "$H/dotfiles/ssh_config")" 'Host keep')"
check "the backup sits next to the real file" "$([[ -e $H/dotfiles/ssh_config.hcloud-sync.bak ]] && echo yes || echo no)"

# --- anything that would not survive as one Host line is refused -------------
H="$(sandbox hostile)"
before_count=$(ls -A "$H/.ssh" | wc -l)
out=$(printf '%s\n' '{"user":"root","key":"","hosts":[{"alias":"p/web\nProxyCommand evil","ip":"1.2.3.4"}]}' | sync "$H")
check "a newline in a server name is refused" "$(contains "$out" 'Refusing to write')"
out=$(printf '%s\n' '{"user":"root","key":"","hosts":[{"alias":"p/web","ip":"1.2.3.4; rm -rf /"}]}' | sync "$H")
check "a HostName that is not an address is refused" "$(contains "$out" 'as a HostName')"
out=$(printf '%s\n' '{"user":"ro ot","key":"","hosts":[]}' | sync "$H")
check "a user with whitespace is refused" "$(contains "$out" 'SSH user')"
out=$(printf '%s\n' '[1, 2]' | sync "$H")
check "a job that is not an object is refused as JSON, not as a traceback" "$(contains "$out" '"ok": false')"
out=$(printf '%s\n' 'not json' | sync "$H")
check "unparseable input is refused as JSON, not as a traceback" "$(contains "$out" '"ok": false')"
check "none of that touched the directory" "$([[ $(ls -A "$H/.ssh" | wc -l) == "$before_count" ]] && echo yes || echo no)"

# --- inputs past their ceiling are refused, not truncated ---------------------
H="$(sandbox ceiling)"
out=$(head -c 300000 /dev/zero | tr '\0' 'a' | sync "$H")
check "a sync job past its ceiling is refused" "$(contains "$out" 'exceeds')"
check "and nothing was written" "$([[ ! -e $H/.ssh/config ]] && echo yes || echo no)"
printf 'Host keep\n' > "$H/.ssh/config"; head -c 1100000 /dev/zero | tr '\0' '#' >> "$H/.ssh/config"
out=$(echo "$JOB" | sync "$H")
check "an ssh config past its ceiling is refused rather than read" "$(contains "$out" 'exceeds')"

# --- argv validation happens before any keyring access -----------------------
out=$("$BRIDGE" metrics prod ../etc 2>&1)
check "a non-numeric server id never reaches a URL" "$(contains "$out" 'numeric server id')"
out=$("$BRIDGE" servers -x 2>&1)
check "a label that looks like an option is that project's error" "$(contains "$out" 'Invalid label')"

# --- uninstall takes the block out and leaves the rest -----------------------
H="$(sandbox uninstall)"
printf 'Host keep\n    HostName 10.0.0.1\n\n' > "$H/.ssh/config"
echo "$JOB" | sync "$H" >/dev/null
out=$(HOME="$H" "$BRIDGE" uninstall)
check "uninstall reports the block gone" "$(contains "$out" '"ssh_block_removed": true')"
check "the markers are gone" "$([[ $(cat "$H/.ssh/config") != *"hcloud-sync"* ]] && echo yes || echo no)"
check "and the hand-written entry stays" "$(contains "$(cat "$H/.ssh/config")" 'Host keep')"
check "the file was backed up first" "$([[ -e $H/.ssh/config.hcloud-sync.bak ]] && echo yes || echo no)"

if (( failures == 0 )); then
  echo "ok — $checks/$checks checks passed"
else
  echo "FAILED — $((checks - failures))/$checks checks passed"
  exit 1
fi
