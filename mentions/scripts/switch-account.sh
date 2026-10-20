#!/usr/bin/env bash
# Point the service at a different Bluesky account.
#
#   ./scripts/switch-account.sh poe.atpota.to <app-password>
#
# Changing the watched account means changing FOUR things together -- the DID,
# the handle, the app password, and the collected data. Doing three of them is
# the failure this exists to prevent: a stale DID means the self-gate guards the
# wrong account, and a stale password means createSession refuses to start
# (src/atproto.js checks the session DID against ATPOTATO_DID on purpose).
set -euo pipefail
# Always the data folder (.env, mentions.db), never the code checkout.
cd "${ATPOTATO_MENTIONS_HOME:-/root/atpotato-mentions}"

HANDLE="${1:-}"
APP_PASSWORD="${2:-}"
# Optional third argument: the handle to RECORD, when it differs from the one
# currently in the DID doc. Mid-migration the account still answers to its old
# handle while the new one waits out a negative-cache window, and what we want
# stored is the handle people will actually type.
HANDLE_OVERRIDE="${3:-}"
if [[ -z "$HANDLE" || -z "$APP_PASSWORD" ]]; then
  echo "usage: $0 <handle|did> <app-password> [handle-to-record]" >&2
  exit 64
fi

# A DID may be given directly. During a handle migration the new handle is not
# resolvable yet -- the record is published but the negative-cache window has
# not expired -- and the service keys on the DID anyway, so waiting on handle
# resolution would block the switch for no reason.
if [[ "$HANDLE" == did:* ]]; then
  DID="$HANDLE"
  echo "using DID directly: $DID"
  HANDLE=$(curl -fsS --max-time 15 "https://plc.directory/${DID}" \
    | /opt/node22/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.alsoKnownAs?.[0]||"").replace(/^at:\/\//,""))})')
  echo "  current handle in the DID doc: ${HANDLE:-<none>}"
else
  echo "resolving $HANDLE ..."
  DID=$(curl -fsS --max-time 15 \
    "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${HANDLE}" \
    | /opt/node22/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.did)throw new Error(j.message||"no did");console.log(j.did)})')
  echo "  -> $DID"
fi

OLD_DID=$(grep -E '^ATPOTATO_DID=' .env | cut -d= -f2- || true)
if [[ "$DID" == "$OLD_DID" ]]; then
  echo "already watching $DID; nothing to do."
  exit 0
fi

TS=$(date +%Y%m%d-%H%M%S)
cp .env ".env.bak-${TS}"

# The queue, seen and cursor rows belong to the old account. Keeping them would
# skew `npm run stats` and leave `seen` entries that suppress nothing useful.
if [[ -f mentions.db ]]; then
  echo "archiving mentions.db -> mentions.db.${OLD_DID:-unknown}.${TS}"
  systemctl stop atpotato-mentions 2>/dev/null || true
  mv mentions.db "mentions.db.${OLD_DID:-unknown}.${TS}"
  rm -f mentions.db-wal mentions.db-shm
fi

if [[ -n "$HANDLE_OVERRIDE" ]]; then
  echo "recording handle as $HANDLE_OVERRIDE (DID doc currently says ${HANDLE:-<none>})"
  HANDLE="$HANDLE_OVERRIDE"
fi

/opt/node22/bin/node -e '
const fs=require("fs");
const [handle,did,pw]=process.argv.slice(1);
let s=fs.readFileSync(".env","utf8");
const set=(k,v)=>{const re=new RegExp("^"+k+"=.*$","m");
  s=re.test(s)?s.replace(re,k+"="+v):s.replace(/\n*$/,"\n")+k+"="+v+"\n";};
set("ATPOTATO_DID",did); set("ATPOTATO_HANDLE",handle); set("ATPROTO_APP_PASSWORD",pw);
fs.writeFileSync(".env",s);
' "$HANDLE" "$DID" "$APP_PASSWORD"
chmod 600 .env

echo "verifying the credential belongs to $DID ..."
/opt/node22/bin/node --env-file=.env -e '
import("./src/atproto.js").then(async ({listNotifications,currentSession})=>{
  try { await listNotifications({limit:1});
    const s=currentSession();
    console.log("  session OK ->",s.handle,s.did);
    process.exit(0);
  } catch(e){ console.error("  FAILED:",e.message); process.exit(1); }
});' 2>&1 | grep -vE 'ExperimentalWarning|trace-warnings|"msg":"atproto session'

systemctl restart atpotato-mentions
sleep 3
systemctl is-active atpotato-mentions
echo "now watching $HANDLE ($DID)"
