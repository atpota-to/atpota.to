#!/usr/bin/env bash
# Deploy one droplet service from atpota-to/atpota.to.
#
#   /root/atpota-live/deploy.sh mentions            # Poe's mentions service (atpotato-mentions)
#   /root/atpota-live/deploy.sh atmosphere          # the weather station (atpotato-weather)
#   /root/atpota-live/deploy.sh garden              # the garden index (atpotato-garden)
#   /root/atpota-live/deploy.sh atmosphere <commit> # a specific commit: a rollback, or a branch to try
#   FORCE=1 /root/atpota-live/deploy.sh mentions    # restart onto it even if its code didn't change
#
# GitHub Actions runs this on every push to main (.github/workflows/deploy-droplet.yml,
# through ci-deploy.sh), so usually nobody needs to.
#
# What it does:
#  1. Unpacks the commit once into releases/<sha>/, a plain copy with no .git: the
#     services' folders, droplet/, and website/shared/ (the garden rules, which garden/
#     imports). Only the folders that exist at that commit, so an older one still
#     unpacks; a release unpacked before a folder was added gets it added.
#  2. Does nothing more if the service isn't set up on this droplet yet (no .env in its
#     data folder): it says so and succeeds, so merging a new service before the operator
#     has set it up doesn't fail the run.
#  3. Does nothing more if the service's code hasn't changed since the release it's
#     running (docs and SQL don't count; for the garden, website/shared/ counts too).
#  4. Runs the service's tests there.
#  5. For Poe, waits until no reply is in flight (npm run in-flight).
#  6. Switches /root/atpota-live/<service>, installs the unit file if it changed (and
#     enables it the first time), and restarts.
#  7. Checks health. If unhealthy, it goes back to the previous release by itself.
#
# A running process keeps reading the release it started from (node resolves the link
# at start). That matters for Poe, which imports modules lazily mid-run and must never
# load half of a new version. One deploy runs at a time.
set -euo pipefail

LIVE=/root/atpota-live
REPO=$LIVE/repo.git
NODE_BIN=/opt/node22/bin
KEEP=5
IDLE_WAIT_S=600
HEALTH_WAIT_S=90

service=${1:-}
case "$service" in
  mentions)
    unit=atpotato-mentions
    data=/root/atpotato-mentions
    health() { curl -fs --max-time 5 http://127.0.0.1:8787/health 2>/dev/null | grep -q '"ok":true'; }
    ;;
  atmosphere)
    unit=atpotato-weather
    data=/root/atpotato-weather
    health() { curl -fs --max-time 5 -o /dev/null http://127.0.0.1:8790/healthz 2>/dev/null; }
    ;;
  garden)
    unit=atpotato-garden
    data=/root/atpotato-garden
    health() { curl -fs --max-time 5 -o /dev/null http://127.0.0.1:8791/healthz 2>/dev/null; }
    ;;
  *)
    echo "usage: $0 <mentions|atmosphere|garden> [commit]" >&2
    exit 64
    ;;
esac

mkdir -p "$LIVE/releases" "$LIVE/logs"
exec 9>"$LIVE/.deploy.lock"
if ! flock -w 1800 9; then
  echo "!! another deploy has held the lock for 30 minutes; giving up" >&2
  exit 75
fi

record() { echo "$(date -u +%FT%TZ) $service ${old_sha:0:12}->${short} $1" >>"$LIVE/logs/deploys.log"; }

git -C "$REPO" fetch --quiet origin '+refs/heads/*:refs/heads/*'
sha=$(git -C "$REPO" rev-parse --verify "${2:-main}^{commit}")
short=${sha:0:12}
release=$LIVE/releases/$short

# git archive fails on a path the commit doesn't have, so ask only for the ones it does
# (an older commit, a rollback, may predate garden/).
parts=()
for p in mentions atmosphere droplet garden website/shared; do
  git -C "$REPO" cat-file -e "$sha:$p" 2>/dev/null && parts+=("$p")
done
if [[ ! -d $release ]]; then
  tmp=$(mktemp -d "$LIVE/releases/.tmp-XXXXXX")
  git -C "$REPO" archive "$sha" "${parts[@]}" | tar -x -C "$tmp"
  echo "$sha" >"$tmp/REVISION"
  chmod 755 "$tmp"
  mv -T "$tmp" "$release"
else
  # Unpacked by an older deploy.sh that didn't know a folder yet: add what's missing,
  # each folder whole or not at all.
  missing=()
  for p in "${parts[@]}"; do [[ -e $release/$p ]] || missing+=("$p"); done
  if [[ ${#missing[@]} -gt 0 ]]; then
    tmp=$(mktemp -d "$LIVE/releases/.tmp-XXXXXX")
    git -C "$REPO" archive "$sha" "${missing[@]}" | tar -x -C "$tmp"
    for p in "${missing[@]}"; do
      mkdir -p "$release/$(dirname "$p")"
      mv -T "$tmp/$p" "$release/$p"
    done
    rm -rf -- "$tmp"
  fi
fi

# The deploy scripts themselves come from the tip of main, never from an older commit
# being rolled back to.
link() { ln -sfn "$1" "$LIVE/.$2.next" && mv -T "$LIVE/.$2.next" "$LIVE/$2"; }
if [[ $sha == "$(git -C "$REPO" rev-parse main)" && -f $release/droplet/ci-deploy.sh ]]; then
  link "releases/$short/droplet/deploy.sh" deploy.sh
  link "releases/$short/droplet/ci-deploy.sh" ci-deploy.sh
fi

previous=$(readlink "$LIVE/$service" 2>/dev/null || true)
old_sha=$([[ -n $previous && -f $LIVE/$previous/../REVISION ]] && cat "$LIVE/$previous/../REVISION" || true)
echo "== $service: ${old_sha:0:12}${old_sha:+ -> }$short"

# A service is set up on this droplet by hand, once (its README says how): until its
# data folder has a .env, there's nothing to deploy it into.
if [[ ! -f $data/.env ]]; then
  echo "== $service is not set up on this droplet yet (no $data/.env); see $service/README.md. Nothing deployed."
  record "not-set-up"
  exit 0
fi
if [[ ! -d $release/$service ]]; then
  echo "!! $short has no $service/ (it predates it); nothing deployed" >&2
  record "no-such-service"
  exit 1
fi

prune() {
  # Keep every release something points at, plus the newest $KEEP.
  declare -A keep=()
  for l in mentions atmosphere garden deploy.sh ci-deploy.sh; do
    target=$(readlink "$LIVE/$l" 2>/dev/null || true)
    [[ $target == releases/* ]] && keep[$(cut -d/ -f2 <<<"$target")]=1
  done
  n=0
  while IFS= read -r dir; do
    n=$((n + 1))
    [[ $n -gt $KEEP && -z ${keep[$(basename "$dir")]:-} ]] && rm -rf -- "$dir"
  done < <(ls -1dt "$LIVE"/releases/*/)
  return 0
}

# Docs and SQL don't change what runs, so they don't restart anything. The garden also
# runs website/shared/ (its types, *.d.ts, are only for the website).
paths=("$service" ':!*.md' ':!*.sql')
[[ $service == garden ]] && paths=(garden website/shared ':!*.md' ':!*.sql' ':!*.d.ts')
if [[ -n $old_sha && -z ${FORCE:-} ]] && git -C "$REPO" diff --quiet "$old_sha" "$sha" -- "${paths[@]}"; then
  echo "== $service/ code is unchanged since ${old_sha:0:12}; nothing to deploy"
  prune
  exit 0
fi
if [[ -n $old_sha ]]; then
  git -C "$REPO" --no-pager diff --stat "$old_sha" "$sha" -- "${paths[@]}" || true
fi

log=$LIVE/logs/test-$service-$short.log
echo "== testing $service at $short"
if ! (cd "$release/$service" && PATH=$NODE_BIN:$PATH npm test >"$log" 2>&1); then
  tail -n 40 "$log" >&2
  echo "!! tests failed; $service stays on ${old_sha:0:12} (full log: $log)" >&2
  record "tests-failed"
  exit 1
fi
grep -E '^ℹ (tests|pass|fail)' "$log" || true

if [[ $service == mentions ]]; then
  # The running release's check first: its db.js matches the live database.
  tool=$LIVE/mentions/src/tools/in-flight.js
  [[ -f $tool ]] || tool=$release/mentions/src/tools/in-flight.js
  if [[ -f $tool ]]; then
    waited=0
    while true; do
      set +e
      status=$(cd "$data" && "$NODE_BIN/node" --no-warnings --env-file=.env "$tool" 2>&1)
      code=$?
      set -e
      [[ $code -eq 0 ]] && break
      if [[ $code -ne 75 ]]; then
        echo "!! could not tell whether Poe is busy: $status" >&2
        record "idle-check-failed"
        exit 1
      fi
      if [[ $waited -ge $IDLE_WAIT_S ]]; then
        echo "!! Poe has been busy for ${IDLE_WAIT_S}s ($status); not restarting. Run the deploy again later." >&2
        record "busy"
        exit 75
      fi
      echo "== waiting for Poe: $status"
      sleep 10
      waited=$((waited + 10))
    done
    echo "== Poe is idle"
  else
    echo "== (no in-flight check in this release; restarting without waiting)"
  fi
fi

unit_file=/etc/systemd/system/$unit.service
unit_backup=$(mktemp)
cp "$unit_file" "$unit_backup" 2>/dev/null || true
if ! cmp -s "$release/$service/$unit.service" "$unit_file"; then
  first_install=$([[ -f $unit_file ]] && echo 0 || echo 1)
  echo "== installing changed $unit.service"
  cp "$release/$service/$unit.service" "$unit_file"
  systemctl daemon-reload
  # A new service starts at boot like the rest. Only the first time: an existing unit's
  # enabled state is the operator's.
  if [[ $first_install -eq 1 ]]; then
    systemctl enable --quiet "$unit"
  fi
fi

link "releases/$short/$service" "$service"
echo "== restarting $unit"
systemctl restart "$unit"

healthy=0
for ((i = 0; i < HEALTH_WAIT_S; i += 3)); do
  sleep 3
  if systemctl is-active --quiet "$unit" && health; then
    healthy=1
    break
  fi
done

if [[ $healthy -eq 1 ]]; then
  echo "== $unit is healthy on $short"
  record "ok"
  rm -f "$unit_backup"
  prune
  exit 0
fi

echo "!! $unit is not healthy on $short after ${HEALTH_WAIT_S}s" >&2
journalctl -u "$unit" --no-pager -o cat -n 30 >&2 || true
if [[ -n $previous ]]; then
  echo "!! rolling back to ${old_sha:0:12}" >&2
  if [[ -s $unit_backup ]] && ! cmp -s "$unit_backup" "$unit_file"; then
    cp "$unit_backup" "$unit_file"
    systemctl daemon-reload
  fi
  link "$previous" "$service"
  systemctl restart "$unit"
  record "unhealthy-rolled-back"
else
  record "unhealthy"
fi
rm -f "$unit_backup"
exit 1
