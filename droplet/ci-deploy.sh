#!/usr/bin/env bash
# The only thing GitHub Actions' deploy key can do on the droplet.
#
# /root/.ssh/authorized_keys pins that key to this script ("restrict,command=..."), so
# whatever the client asks to run, this runs instead, with the request in
# $SSH_ORIGINAL_COMMAND. It accepts exactly "<mentions|atmosphere|garden> [<full sha>]",
# where the commit must be on main, and hands it to deploy.sh. That fetches the code from
# GitHub itself: the key can trigger a deploy of what's already on main and nothing else.
set -euo pipefail

read -r service sha extra <<<"${SSH_ORIGINAL_COMMAND:-}" || true
refuse() {
  echo "refused: $1 (expected \"<mentions|atmosphere|garden> [<commit on main>]\")" >&2
  exit 64
}
case "${service:-}" in
  mentions | atmosphere | garden) ;;
  *) refuse "unknown service '${service:-}'" ;;
esac
[[ -z ${extra:-} ]] || refuse "too many arguments"
if [[ -n ${sha:-} ]]; then
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || refuse "the commit must be a full 40-character sha"
  repo=/root/atpota-live/repo.git
  git -C "$repo" fetch --quiet origin '+refs/heads/main:refs/heads/main'
  git -C "$repo" merge-base --is-ancestor "$sha" main 2>/dev/null || refuse "$sha is not on main"
fi
exec /root/atpota-live/deploy.sh "$service" ${sha:+"$sha"}
