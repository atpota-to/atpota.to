#!/usr/bin/env bash
# Deploy one droplet service from atpota-to/atpota.to.
#
#   /root/atpota-live/deploy.sh mentions            # Poe's mentions service (atpotato-mentions)
#   /root/atpota-live/deploy.sh atmosphere          # the weather station (atpotato-weather)
#   /root/atpota-live/deploy.sh atmosphere <commit> # a specific commit: a rollback, or a branch to try
#
# Each commit is unpacked once into releases/<sha>/ (a plain copy, no .git). The
# service's tests run there first; only if they pass does /root/atpota-live/<service>
# switch to it and the unit restart. A running process keeps reading the release it
# started from (node resolves the link at start). That matters for Poe, which imports
# modules lazily mid-run and must never load half of a new version.
#
# The unit file comes from the release too: if it changed, it is installed and
# systemd reloaded before the restart.
set -euo pipefail

LIVE=/root/atpota-live
REPO=$LIVE/repo.git
NODE_BIN=/opt/node22/bin
KEEP=5

service=${1:-}
case "$service" in
  mentions) unit=atpotato-mentions ;;
  atmosphere) unit=atpotato-weather ;;
  *)
    echo "usage: $0 <mentions|atmosphere> [commit]" >&2
    exit 64
    ;;
esac

git -C "$REPO" fetch --quiet origin '+refs/heads/*:refs/heads/*'
sha=$(git -C "$REPO" rev-parse --verify "${2:-main}^{commit}")
short=${sha:0:12}
release=$LIVE/releases/$short

if [[ ! -d $release ]]; then
  mkdir -p "$LIVE/releases"
  tmp=$(mktemp -d "$LIVE/releases/.tmp-XXXXXX")
  git -C "$REPO" archive "$sha" mentions atmosphere droplet | tar -x -C "$tmp"
  echo "$sha" >"$tmp/REVISION"
  chmod 755 "$tmp"
  mv -T "$tmp" "$release"
fi

previous=$(readlink -f "$LIVE/$service" 2>/dev/null || true)
old_sha=$([[ -n $previous && -f $previous/../REVISION ]] && cat "$previous/../REVISION" || true)
echo "== $service: ${old_sha:0:12}${old_sha:+ -> }$short"
if [[ -n $old_sha && $old_sha != "$sha" ]]; then
  git -C "$REPO" --no-pager diff --stat "$old_sha" "$sha" -- "$service" || true
fi

mkdir -p "$LIVE/logs"
log=$LIVE/logs/test-$service-$short.log
echo "== testing $service at $short (log: $log)"
if ! (cd "$release/$service" && PATH=$NODE_BIN:$PATH npm test >"$log" 2>&1); then
  tail -n 40 "$log" >&2
  echo "!! tests failed; $service stays on ${old_sha:0:12}" >&2
  exit 1
fi
grep -E '^ℹ (tests|pass|fail)' "$log" || true

if ! cmp -s "$release/$service/$unit.service" "/etc/systemd/system/$unit.service"; then
  echo "== installing changed $unit.service"
  cp "$release/$service/$unit.service" "/etc/systemd/system/$unit.service"
  systemctl daemon-reload
fi

ln -sfn "releases/$short/$service" "$LIVE/.$service.next"
mv -T "$LIVE/.$service.next" "$LIVE/$service"
ln -sfn "releases/$short/droplet/deploy.sh" "$LIVE/.deploy.next"
mv -T "$LIVE/.deploy.next" "$LIVE/deploy.sh"

echo "== restarting $unit"
systemctl restart "$unit"
sleep 3
if ! systemctl is-active --quiet "$unit"; then
  echo "!! $unit is not active after restart. Roll back with: $0 $service ${old_sha:-<commit>}" >&2
  exit 1
fi
echo "== $unit is running $short"

# Keep every release something points at, plus the newest $KEEP.
declare -A keep=()
for link in "$LIVE"/mentions "$LIVE"/atmosphere "$LIVE"/deploy.sh; do
  target=$(readlink "$link" 2>/dev/null || true)
  [[ $target == releases/* ]] && keep[$(cut -d/ -f2 <<<"$target")]=1
done
n=0
while IFS= read -r dir; do
  n=$((n + 1))
  name=$(basename "$dir")
  if [[ $n -gt $KEEP && -z ${keep[$name]:-} ]]; then
    rm -rf -- "$dir"
  fi
done < <(ls -1dt "$LIVE"/releases/*/)
