#!/usr/bin/env bash
# Reviewed host-side operation. Invoke only after the exact revision's complete Rust CI passes.
# Usage for this reviewed candidate: publish-release.sh staging FULL_REVISION ARCHIVE_SHA256
# The retained production branch is disabled by the explicit staging-only guard below.
# Never execute this file merely to validate it: bash -n is the local syntax check.
set -euo pipefail
umask 077
fail() { printf 'release: %s\n' "$1" >&2; exit 1; }
[[ $# == 3 ]] || fail 'usage: staging FULL_REVISION ARCHIVE_SHA256'
ENVIRONMENT=$1 REV=$2 ARCHIVE_SHA256=$3
[[ "$ENVIRONMENT" == staging ]] || fail 'this reviewed operation is authorized for staging only'
PINNED_REV=f7be8eb1beefc92c713c6f807c89ff1192945fad
# This candidate carries no migration: the database is at schema 40 before and after. The checks
# below refuse a candidate that would apply one.
[[ "$REV" == "$PINNED_REV" && "$REV" =~ ^[0-9a-f]{40}$ ]] || fail 'unreviewed candidate revision'
[[ "$ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'invalid archive digest'
[[ "$EUID" == 0 ]] || fail 'run as root on the audited installation'
ARCHIVE=/root/jeeta-release-${REV:0:8}.tar
DEST=/opt/jeeta/releases/$REV
HOOK=/etc/jeeta/recovery-control
HOOK_SHA256=f83698fae40dd1f12dfe032fbc344b30d67dee1894ec3579fbc6cc5527c3bea1
case "$ENVIRONMENT" in
  staging)
    UNIT=jeeta-staging.service LINK=/opt/jeeta/staging-current OTHER_LINK=/opt/jeeta/current
    ENVFILE=/etc/jeeta-staging/jeeta.env PORT=5437 HTTP_PORT=8091 REHEARSAL_PORT=18091
    SERVICE_USER=jeeta-staging FILES=/var/lib/jeeta-staging/files HOST=staging.jeetagrowth.com
    PREDECESSOR=a00fe6cc48a51ef024fbf6bd8827b3750d7daad2
    UPGRADE=/root/staging-upgrade.sh
    UPGRADE_SHA256=120ff74c1b8ae34cc6f9a23328b5425f2c67818a4b9a3b32fd56a9c3b5935929
    BACKUP_ROOT=/var/backups/jeeta-staging/release-operations
    ;;
  production)
    UNIT=jeeta.service LINK=/opt/jeeta/current OTHER_LINK=/opt/jeeta/staging-current
    ENVFILE=/etc/jeeta/jeeta.env PORT=5436 HTTP_PORT=8090 REHEARSAL_PORT=18090
    SERVICE_USER=jeeta FILES=/var/lib/jeeta/files HOST=yeni.jeetagrowth.com
    PREDECESSOR=095221a121801bbd807967c576fdb53046b3b23e
    UPGRADE=/root/upgrade.sh
    UPGRADE_SHA256=ffcc735e8e3efbd350b564b06059b4221fb1d56afae48366dc86a93bc53d32a7
    BACKUP_ROOT=/var/backups/jeeta/release-operations
    ;;
  *) fail 'unknown environment; production is the existing Rust yeni installation only';;
esac
# One lock covers both environments and the shared immutable release directory.
[[ ! -L /run/jeeta-release-publish.lock ]] || fail 'unsafe operation lock'
exec 9>/run/jeeta-release-publish.lock
flock -n 9 || fail 'another release operation is running'
private_file() {
  [[ -f "$1" && ! -L "$1" && $(stat -c %u "$1") == 0 ]] || fail 'missing or unsafe protected input'
  local mode; mode=$(stat -c %a "$1")
  (( (8#$mode & 077) == 0 )) || fail 'protected input must be root-only'
}
check_digest() { printf '%s  %s\n' "$1" "$2" | sha256sum --check --status; }
[[ -f "$ARCHIVE" && ! -L "$ARCHIVE" && $(stat -c %u "$ARCHIVE") == 0 ]] || fail 'unsafe archive'
ARCHIVE_MODE=$(stat -c %a "$ARCHIVE")
(( (8#$ARCHIVE_MODE & 022) == 0 )) || fail 'archive must not be writable by another user'
private_file "$ENVFILE"
check_digest "$ARCHIVE_SHA256" "$ARCHIVE" || fail 'archive digest differs'
[[ -f "$UPGRADE" && ! -L "$UPGRADE" && $(stat -c %u "$UPGRADE") == 0 ]] || fail 'unsafe upgrader'
check_digest "$UPGRADE_SHA256" "$UPGRADE" || fail 'audited upgrader changed'
if [[ "$ENVIRONMENT" == production ]]; then
  private_file "$HOOK"
  [[ -x "$HOOK" ]] || fail 'recovery hook is not executable'
  check_digest "$HOOK_SHA256" "$HOOK" || fail 'audited recovery hook changed'
fi
systemctl is-active --quiet "$UNIT" || fail 'target service is not active'
[[ $(systemctl show "$UNIT" -p User --value) == "$SERVICE_USER" ]] || fail 'service user differs'
[[ $(systemctl show "$UNIT" -p Group --value) == "$SERVICE_USER" ]] || fail 'service group differs'
[[ -L "$LINK" && -L "$OTHER_LINK" ]] || fail 'release pointers must be symlinks'
PREVIOUS=$(readlink -f "$LINK") OTHER_PREVIOUS=$(readlink -f "$OTHER_LINK")
[[ "$PREVIOUS" == /opt/jeeta/releases/"$PREDECESSOR" ]] || fail 'unexpected target predecessor'
[[ $(cat "$PREVIOUS/REVISION") == "$PREDECESSOR" ]] || fail 'predecessor revision differs'
CANDIDATE=$(mktemp -d /opt/jeeta/.release-candidate.XXXXXX)
BACKUP='' VERIFY_UNIT='' VERIFY_DB='' STOPPED=0 CHANGED=0
migration_snapshot() {
  sudo -u postgres psql -XAt -p "$PORT" -d "$1" -v ON_ERROR_STOP=1 -c \
    "SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version"
}
stop_target() {
  if [[ "$ENVIRONMENT" == production ]]; then
    "$HOOK" block
    "$HOOK" stop
    "$HOOK" assert_quiesced
  else
    systemctl stop "$UNIT"
    ! systemctl is-active --quiet "$UNIT"
    [[ -z $(ss -Hltn "sport = :$HTTP_PORT") ]]
  fi
}
start_previous() {
  # This branch runs only before invoking the upgrader, against the untouched original DB.
  [[ $(readlink -f "$LINK") == "$PREVIOUS" && $(readlink -f "$OTHER_LINK") == "$OTHER_PREVIOUS" ]] || return 1
  check_digest "$(cat "$CANDIDATE/environment.sha256")" "$ENVFILE" || return 1
  migration_snapshot jeeta > "$CANDIDATE/restart-migrations" || return 1
  cmp -s "$CANDIDATE/database-migrations" "$CANDIDATE/restart-migrations" || return 1
  if [[ "$ENVIRONMENT" == production ]]; then "$HOOK" start && "$HOOK" unblock
  else
    systemctl start "$UNIT" || return 1
    local ready=0
    for attempt in $(seq 1 30); do
      if curl --fail --silent --max-time 2 --noproxy '*' -H "Host: $HOST" "http://127.0.0.1:$HTTP_PORT/readyz" >/dev/null; then ready=1; break; fi
      sleep 1
    done
    [[ "$ready" == 1 ]] && systemctl is-active --quiet "$UNIT"
  fi
}
on_exit() {
  local rc=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ -n "$VERIFY_UNIT" ]]; then systemctl stop "$VERIFY_UNIT" >/dev/null 2>&1; fi
  if (( rc != 0 )); then
    if (( CHANGED )); then
      # Existing upgraders may have started/unfenced the candidate before a late failure.
      # Always fence/stop it FIRST. Never reset runtime DB/files or run downs/old binaries.
      if [[ "$ENVIRONMENT" == production ]]; then "$HOOK" block >/dev/null 2>&1; fi
      systemctl stop "$UNIT" >/dev/null 2>&1
      if systemctl is-active --quiet "$UNIT"; then
        printf '::error::Candidate failure; target stop failed; urgent manual fencing required\n' >&2
      fi
      printf '::error::Publication failed; fencing and stop attempted, current DB/files and recovery set retained. No automatic schema or binary rollback.\n' >&2
    elif (( STOPPED )); then
      if ! start_previous; then
        if [[ "$ENVIRONMENT" == production ]]; then "$HOOK" block >/dev/null 2>&1; fi
        systemctl stop "$UNIT" >/dev/null 2>&1
        printf '::error::Pre-publication validation failed; safe restart refused; inspect recovery set privately\n' >&2
      fi
    fi
    [[ -z "$BACKUP" ]] || printf 'Recovery evidence retained: %s\n' "$BACKUP" >&2
    [[ -z "$VERIFY_DB" ]] || printf 'Isolated rehearsal database retained: %s\n' "$VERIFY_DB" >&2
  fi
  rm -rf -- "$CANDIDATE"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Verify all archive members and contents before any application is stopped. Secret values stay
# inside this process or protected files; never source/print the environment or pass a DSN in argv.
python3 -I - "$ARCHIVE" "$CANDIDATE" "$REV" "$ENVIRONMENT" "$ENVFILE" "$FILES" "$PORT" "$HTTP_PORT" "$HOST" "$PREVIOUS" <<'PY'
import hashlib,json,os,pathlib,re,shlex,stat,subprocess,sys,tarfile,urllib.parse
archive,dest,rev,environment,envfile,files,port,http_port,host,previous=sys.argv[1:]
root=pathlib.Path(dest)
with tarfile.open(archive) as source:
    seen=set()
    for member in source.getmembers():
        p=pathlib.PurePosixPath(member.name)
        assert p.parts and p.parts[0]=='jeeta-release' and '..' not in p.parts and not p.is_absolute(), 'Unsafe archive path'
        assert p.as_posix() not in seen, 'Duplicate archive member'
        seen.add(p.as_posix())
        assert member.isfile() or member.isdir(), 'Special archive member refused'
        assert not member.mode & 0o7000, 'Privileged archive permissions refused'
    source.extractall(dest)
# Do not inherit the CI runner's uid/gid or writable modes from tar headers.
r=root/'jeeta-release'
for path in [r,*r.rglob('*')]:
    name=path.relative_to(r).as_posix()
    os.chown(path,0,0)
    executable=name=='jeeta' or (name.startswith('scripts/') and name.endswith('.sh'))
    path.chmod(0o755 if path.is_dir() or executable else 0o644)
m=json.loads((r/'manifest.json').read_text())
assert m['source_revision']==rev and m['source_clean'] is True
assert (r/'REVISION').read_text().strip()==rev and m['format']==1
assert m['schema_version']==40 and m['migration_versions']==list(range(1,41))
assert m['binary_checksum']['algorithm']=='sha256' and m['panel_checksum']['algorithm']=='sha256'
assert m['panel_checksum']['manifest']=='panel.sha256'
assert hashlib.sha256((r/'jeeta').read_bytes()).hexdigest()==m['binary_checksum']['value']
assert hashlib.sha256((r/'panel.sha256').read_bytes()).hexdigest()==m['panel_checksum']['value']
assert (r/'panel/index.html').is_file() and all((r/p).is_dir() for p in ['migrations','scripts','deploy','docs/operations'])
listed=[]
for line in (r/'panel.sha256').read_text().splitlines():
    digest,separator,name=line.partition('  ');p=pathlib.PurePosixPath(name)
    assert separator and re.fullmatch('[0-9a-f]{64}',digest) and p.parts[0]=='panel' and '..' not in p.parts and not p.is_absolute()
    assert hashlib.sha256((r/name).read_bytes()).hexdigest()==digest
    listed.append(name)
assert listed==sorted(p.relative_to(r).as_posix() for p in (r/'panel').rglob('*') if p.is_file()), 'Panel inventory differs'
expected={}
for entry in m['migrations']:
    version=entry['version'];assert version not in expected
    for direction in ['up','down']:
        name=entry[direction]
        assert pathlib.PurePosixPath(name).name==name and name.endswith('.'+direction+'.sql')
        assert hashlib.sha384((r/'migrations'/name).read_bytes()).hexdigest()==entry[direction+'_sha384']
    expected[version]=entry
assert list(expected)==list(range(1,41))
assert {p.name for p in (r/'migrations').iterdir()}=={e[k] for e in expected.values() for k in ['up','down']}
values={}
for line in pathlib.Path(envfile).read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'):continue
    key,separator,value=line.partition('=');assert separator and re.fullmatch('JEETA_[A-Z0-9_]+',key)
    parsed=shlex.split(value,comments=True);assert len(parsed)<=1, 'Unsupported EnvironmentFile value'
    assert key not in values, 'Duplicate environment key'
    values[key]=parsed[0] if parsed else ''
u=urllib.parse.urlparse(values['JEETA_DATABASE_URL'])
assert u.scheme in ['postgres','postgresql'] and u.hostname in ['localhost','127.0.0.1'] and u.port==int(port) and u.path=='/jeeta'
query=urllib.parse.parse_qsl(u.query)
assert not u.fragment and not ({k for k,_ in query} & {'hostaddr','port','dbname','user','password','passfile','service','servicefile','options'})
# The audited installations use libpq's host query selector. Permit only local transports;
# the port/database/role remain pinned above and below, including for the isolated restore.
hosts=[value for key,value in query if key=='host']
assert len(hosts)<=1 and all(value in ('localhost','127.0.0.1','::1','/var/run/postgresql','/run/postgresql') for value in hosts), 'Database host selector must be local'
assert values['JEETA_BIND']=='127.0.0.1:'+http_port and values['JEETA_PUBLIC_BASE_URL']=='https://'+host
assert values['JEETA_FILES_DIR']==files
assert values.get('JEETA_PANEL_DIR')==('/opt/jeeta/staging-current/panel' if environment=='staging' else '/opt/jeeta/current/panel')
assert values.get('JEETA_JOBS_ENABLED')=='true' and values.get('JEETA_ALLOW_SUPERUSER','') not in ['true','1']
assert not values.get('JEETA_PLATFORM_BOOTSTRAP_RESET') or values['JEETA_PLATFORM_BOOTSTRAP_RESET']=='0'
assert re.fullmatch('[0-9a-fA-F]{64}',values['JEETA_SECRET_KEY'])
f=pathlib.Path(files);assert f.is_dir()
for p in [f,*f.parents]:assert not p.is_symlink(), 'Symlink in files path'
for p in f.rglob('*'):assert p.is_file() or p.is_dir();assert not p.is_symlink(), 'Unsafe files tree'
role=urllib.parse.unquote(u.username or '')
assert re.fullmatch('[A-Za-z_][A-Za-z0-9_-]*',role), 'Unsupported database role'
def sql(query):
    return subprocess.check_output(['sudo','-u','postgres','psql','-XAt','-p',port,'-d','jeeta','-v','ON_ERROR_STOP=1','-c',query],text=True)
assert sql("SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='"+role+"'").strip()=='f|f|t', 'Application role must be ordinary'
rows=sql("SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version")
actual=[line.split('|') for line in rows.splitlines()]
versions=list(range(1,41)) if environment=='staging' else list(range(1,20))+list(range(21,26))
assert [int(row[0]) for row in actual]==versions, 'Unexpected applied migration set'
assert all(row==[str(int(row[0])),expected[int(row[0])]['up_sha384'],'t'] for row in actual), 'Changed or failed migration'
assert set(expected)-set(versions)==(set() if environment=='staging' else {20,*range(26,41)})
if environment=='staging':
    # The predecessor's schema 40, as its release left it.
    assert sql("SELECT to_regclass('public.social_account_days') IS NOT NULL AND to_regclass('public.ads_campaigns') IS NOT NULL AND to_regclass('public.workspace_modules') IS NOT NULL").strip()=='t', 'A table of the predecessor is missing'
    assert sql("SELECT to_regclass('public.commissions') IS NULL AND to_regclass('public.commission_default') IS NULL AND to_regclass('public.commission_user_rates') IS NULL").strip()=='t', 'Unexpected commission table'
old=json.loads((pathlib.Path(previous)/'manifest.json').read_text())
assert old['source_revision']==pathlib.Path(previous).name
assert [x['version'] for x in old['migrations']]==versions
assert all(entry==expected[entry['version']] for entry in old['migrations']), 'Previous packaged migrations differ'
(root/'expected-migrations').write_text(''.join(f"{v}|{e['up_sha384']}|t\n" for v,e in expected.items()))
(root/'database-migrations').write_text(rows)
(root/'database-role').write_text(role)
(root/'environment.sha256').write_text(hashlib.sha256(pathlib.Path(envfile).read_bytes()).hexdigest())
print('Complete candidate verified; exact predecessor matches and the candidate carries no migration')
PY
# A complete content comparison prevents the upgraders' existing-directory shortcut from
# accepting stale scripts/docs/extra assets. Installed paths must be root-owned and immutable.
cat > "$CANDIDATE/compare-release.py" <<'PY'
import hashlib,pathlib,stat,sys
candidate,installed=map(pathlib.Path,sys.argv[1:])
def tree(root,check_modes=False):
    assert root.is_dir() and not root.is_symlink()
    result={}
    for p in [root,*root.rglob('*')]:
        s=p.lstat();name=p.relative_to(root).as_posix()
        assert stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode), 'Special release member refused'
        if check_modes:
            executable=name=='jeeta' or (name.startswith('scripts/') and name.endswith('.sh'))
            assert s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==(0o755 if p.is_dir() or executable else 0o644), 'Installed release ownership/mode differs'
        result[name]=('d',None) if p.is_dir() else ('f',hashlib.sha256(p.read_bytes()).hexdigest())
    return result
assert tree(candidate)==tree(installed,True), 'Complete installed release tree differs'
PY
if [[ -e "$DEST" || -L "$DEST" ]]; then python3 -I "$CANDIDATE/compare-release.py" "$CANDIDATE/jeeta-release" "$DEST"; fi
PROMOTIONS=/var/backups/jeeta-release/promotions
if [[ "$ENVIRONMENT" == production ]]; then
  # Promote the identical archive already proven in staging, without copying its runtime data.
  [[ $(readlink -f /opt/jeeta/staging-current) == "$DEST" ]] || fail 'candidate has not been installed in staging'
  private_file "$PROMOTIONS/$REV.staging.json"
  python3 -I - "$PROMOTIONS/$REV.staging.json" "$REV" "$ARCHIVE_SHA256" <<'PY'
import json,sys
record=json.load(open(sys.argv[1]));assert record['environment']=='staging' and record['revision']==sys.argv[2] and record['archive_sha256']==sys.argv[3] and record['schema_version']==40
PY
  systemctl is-active --quiet jeeta-staging.service
  curl --fail --silent --max-time 10 --noproxy '*' -H 'Host: staging.jeetagrowth.com' http://127.0.0.1:8091/readyz >/dev/null
fi
install -d -m 0700 "$BACKUP_ROOT"
BACKUP=$(mktemp -d "$BACKUP_ROOT/pre-${REV:0:8}-$ENVIRONMENT-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
APP_ROLE=$(cat "$CANDIDATE/database-role")
DB_SIZE=$(sudo -u postgres psql -XAt -p "$PORT" -d jeeta -c 'SELECT pg_database_size(current_database())')
FILES_SIZE=$(du -sb "$FILES" | cut -f1)
PG_DATA=$(sudo -u postgres psql -XAt -p "$PORT" -d jeeta -c 'SHOW data_directory')
python3 -I - "$DB_SIZE" "$FILES_SIZE" "$BACKUP" "$PG_DATA" "$CANDIDATE" "$REHEARSAL_PORT" <<'PY'
import shutil,socket,sys
need=3*int(sys.argv[1])+3*int(sys.argv[2])+512*1024*1024
assert all(shutil.disk_usage(p).free>need for p in sys.argv[3:6]), 'Insufficient recovery/rehearsal space'
with socket.socket() as probe:probe.bind(('127.0.0.1',int(sys.argv[6])))
PY
[[ $(readlink -f "$LINK") == "$PREVIOUS" && $(readlink -f "$OTHER_LINK") == "$OTHER_PREVIOUS" ]] || fail 'release pointer changed'
# Set the recovery state BEFORE stop so a partial stop/fence failure cannot bypass the trap.
STOPPED=1
stop_target
migration_snapshot jeeta > "$CANDIDATE/stopped-migrations"
cmp "$CANDIDATE/database-migrations" "$CANDIDATE/stopped-migrations"
# Refuse another application-role connection (including stdio) rather than backing up while it writes.
sudo -u postgres psql -XAt -p "$PORT" -d jeeta -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_stat_activity WHERE datname='jeeta' AND usename='$APP_ROLE' AND backend_type='client backend'" > "$CANDIDATE/remaining-clients"
[[ $(cat "$CANDIDATE/remaining-clients") == 0 ]] || fail 'another application client remains connected'
check_digest "$(cat "$CANDIDATE/environment.sha256")" "$ENVFILE" || fail 'environment changed'
sudo -u postgres pg_dump -p "$PORT" -Fc jeeta > "$BACKUP/database.dump" 2> "$BACKUP/dump.log"
pg_restore --list "$BACKUP/database.dump" > "$BACKUP/database.contents" 2>> "$BACKUP/dump.log"
[[ -s "$BACKUP/database.contents" ]] || fail 'empty backup inventory'
tar -C "$FILES" -cf "$BACKUP/files.tar" .
install -m 0600 "$ENVFILE" "$BACKUP/jeeta.env"
cp "$PREVIOUS/manifest.json" "$PREVIOUS/REVISION" "$CANDIDATE/database-migrations" "$BACKUP/"
printf '%s\n' "$PREVIOUS" > "$BACKUP/previous-release"
# Restore BOTH database and files independently from the recovery set, never into live paths.
VERIFY_DB=jeeta_verify_${ENVIRONMENT}_${REV:0:8}_$(date +%s)
sudo -u postgres createdb -p "$PORT" --owner "$APP_ROLE" "$VERIFY_DB"
if ! sudo -u postgres pg_restore -p "$PORT" --exit-on-error -d "$VERIFY_DB" < "$BACKUP/database.dump" > "$BACKUP/restore.log" 2>&1; then
  fail 'isolated backup restore failed; inspect protected restore.log'
fi
migration_snapshot "$VERIFY_DB" > "$BACKUP/restored-migrations"
cmp "$CANDIDATE/database-migrations" "$BACKUP/restored-migrations"
install -d -m 0700 "$CANDIDATE/rehearsal-files"
# Validate recovery archive members before extracting, then prove restored bytes equal source.
python3 -I - "$FILES" "$CANDIDATE/rehearsal-files" "$BACKUP/files.tar" <<'PY'
import hashlib,pathlib,sys,tarfile
roots=list(map(pathlib.Path,sys.argv[1:3]))
with tarfile.open(sys.argv[3]) as archive:
    for member in archive.getmembers():
        path=pathlib.PurePosixPath(member.name)
        assert not path.is_absolute() and '..' not in path.parts and (member.isfile() or member.isdir())
    archive.extractall(roots[1])
def inventory(root):
    out={}
    for p in root.rglob('*'):
        assert not p.is_symlink() and (p.is_file() or p.is_dir())
        out[p.relative_to(root).as_posix()]=None if p.is_dir() else hashlib.sha256(p.read_bytes()).hexdigest()
    return out
assert inventory(roots[0])==inventory(roots[1]), 'Recovered FileStore differs'
PY
chmod 0755 "$CANDIDATE" "$CANDIDATE/jeeta-release" "$CANDIDATE/jeeta-release/jeeta"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CANDIDATE/rehearsal-files"
chmod 0700 "$CANDIDATE/rehearsal-files"
python3 -I - "$CANDIDATE" "$BACKUP/jeeta.env" "$VERIFY_DB" "$REHEARSAL_PORT" <<'PY'
import json,pathlib,shlex,sys,urllib.parse
root=pathlib.Path(sys.argv[1]);database=sys.argv[3];port=sys.argv[4]
keep={'JEETA_DATABASE_URL','JEETA_SECRET_KEY','JEETA_PRICE_MINOR','JEETA_PRICE_CURRENCY','JEETA_BANK_INSTRUCTIONS','JEETA_METRICS_TOKEN'}
values={}
for line in pathlib.Path(sys.argv[2]).read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'):continue
    key,_,value=line.partition('=')
    if key in keep:values[key]=shlex.split(value,comments=True)[0]
assert set(values)==keep and database.startswith('jeeta_verify_')
u=urllib.parse.urlparse(values['JEETA_DATABASE_URL']);values['JEETA_DATABASE_URL']=urllib.parse.urlunparse(u._replace(path='/'+database))
values.update(JEETA_BIND='127.0.0.1:'+port,JEETA_ALLOWED_HOSTS='127.0.0.1:'+port,JEETA_PUBLIC_BASE_URL='https://release-rehearsal.invalid',JEETA_JOBS_ENABLED='false',JEETA_OUTREACH_ENABLED='false',JEETA_FILES_DIR=str(root/'rehearsal-files'),JEETA_PANEL_DIR=str(root/'jeeta-release/panel'),JEETA_LOG='warn',JEETA_LOG_FORMAT='json',JEETA_COOKIE_SECURE='true')
(root/'rehearsal.env').write_text(''.join(k+'='+json.dumps(v,ensure_ascii=False)+'\n' for k,v in values.items()));(root/'rehearsal.env').chmod(0o600)
PY
sudo -u postgres psql -XAt -p "$PORT" -d "$VERIFY_DB" -v ON_ERROR_STOP=1 -c \
  "SELECT format('SELECT %L, count(*) FROM %I.%I;', tablename, schemaname, tablename) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('_sqlx_migrations') ORDER BY tablename" > "$BACKUP/count-original-tables.sql"
sudo -u postgres psql -XAt -p "$PORT" -d "$VERIFY_DB" -v ON_ERROR_STOP=1 < "$BACKUP/count-original-tables.sql" > "$BACKUP/rows-before"
# The checks below are written for staging's predecessor (schema 40) and a candidate without a
# migration: every table keeps its row count through the candidate's start, the module registry
# included. The retained production branch must be reworked before it is enabled.
VERIFY_UNIT=jeeta-${ENVIRONMENT}-rehearsal-${REV:0:8}-$(date +%s)
UNSET_ENV='JEETA_PLATFORM_BOOTSTRAP_EMAIL JEETA_PLATFORM_BOOTSTRAP_PASSWORD JEETA_PLATFORM_BOOTSTRAP_RESET JEETA_META_APP_ID JEETA_META_APP_SECRET JEETA_META_VERIFY_TOKEN JEETA_META_LOGIN_CONFIG_ID JEETA_META_WHATSAPP_CONFIG_ID JEETA_META_GRAPH_VERSION JEETA_META_COMMENT_SCOPES JEETA_INSTAGRAM_APP_ID JEETA_INSTAGRAM_APP_SECRET JEETA_INSTAGRAM_COMMENT_SCOPES JEETA_X_CLIENT_ID JEETA_X_CLIENT_SECRET JEETA_TIKTOK_CLIENT_KEY JEETA_TIKTOK_CLIENT_SECRET JEETA_LINKEDIN_CLIENT_ID JEETA_LINKEDIN_CLIENT_SECRET JEETA_LINKEDIN_API_VERSION JEETA_LINKEDIN_ORG_SCOPES JEETA_HEPSIBURADA_INTEGRATOR_USER JEETA_RECOVERY_STATUS_DIR JEETA_WAL_ARCHIVE_DIR JEETA_ALLOW_SUPERUSER JEETA_ALLOW_TEST_LOOPBACK JEETA_STDIO_API_KEY JEETA_TEST_DATABASE_URL'
systemd-run --quiet --unit="$VERIFY_UNIT" --property=Type=simple --property=User="$SERVICE_USER" --property=Group="$SERVICE_USER" \
  --property=WorkingDirectory="$CANDIDATE" --property=EnvironmentFile="$CANDIDATE/rehearsal.env" --property="UnsetEnvironment=$UNSET_ENV" \
  --property=IPAddressDeny=any --property=IPAddressAllow=localhost --property=NoNewPrivileges=yes \
  --property=ProtectHome=yes --property=PrivateTmp=yes --property=ProtectSystem=strict --property=ReadWritePaths="$CANDIDATE/rehearsal-files" \
  "$CANDIDATE/jeeta-release/jeeta" serve
REHEARSAL_READY=0
for attempt in $(seq 1 60); do
  if curl --fail --silent --max-time 2 --noproxy '*' -H "Host: 127.0.0.1:$REHEARSAL_PORT" "http://127.0.0.1:$REHEARSAL_PORT/readyz" >/dev/null; then REHEARSAL_READY=1; break; fi
  sleep 1
done
journalctl -u "$VERIFY_UNIT" --no-pager > "$BACKUP/rehearsal.log"
[[ "$REHEARSAL_READY" == 1 ]] || fail 'isolated candidate failed readiness'
systemctl is-active --quiet "$VERIFY_UNIT"
systemctl stop "$VERIFY_UNIT"
VERIFY_UNIT=''
migration_snapshot "$VERIFY_DB" > "$BACKUP/rehearsed-migrations"
cmp "$CANDIDATE/expected-migrations" "$BACKUP/rehearsed-migrations"
sudo -u postgres psql -XAt -p "$PORT" -d "$VERIFY_DB" -v ON_ERROR_STOP=1 < "$BACKUP/count-original-tables.sql" > "$BACKUP/rows-after"
cmp "$BACKUP/rows-before" "$BACKUP/rows-after"
sudo -u postgres psql -XAt -p "$PORT" -d "$VERIFY_DB" -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_class WHERE relname IN ('social_account_days','ads_campaigns') AND relnamespace='public'::regnamespace AND relrowsecurity AND relforcerowsecurity" > "$BACKUP/analysis-rls"
[[ $(cat "$BACKUP/analysis-rls") == 2 ]] || fail 'social account and ad campaign tables must force RLS'
sudo -u postgres dropdb -p "$PORT" "$VERIFY_DB"
VERIFY_DB=''
(cd "$BACKUP" && sha256sum database.dump files.tar jeeta.env manifest.json REVISION database-migrations > SHA256SUMS && sha256sum --check --status SHA256SUMS)
# Recheck everything mutable immediately before handing control to the audited upgrader.
[[ $(readlink -f "$LINK") == "$PREVIOUS" && $(readlink -f "$OTHER_LINK") == "$OTHER_PREVIOUS" ]] || fail 'release pointer changed'
check_digest "$(cat "$CANDIDATE/environment.sha256")" "$ENVFILE" || fail 'environment changed'
check_digest "$ARCHIVE_SHA256" "$ARCHIVE" || fail 'archive changed'
check_digest "$UPGRADE_SHA256" "$UPGRADE" || fail 'upgrader changed'
if [[ "$ENVIRONMENT" == production ]]; then check_digest "$HOOK_SHA256" "$HOOK" || fail 'recovery hook changed'; fi
migration_snapshot jeeta > "$CANDIDATE/pre-publish-migrations"
cmp "$CANDIDATE/database-migrations" "$CANDIDATE/pre-publish-migrations"
if [[ -e "$DEST" || -L "$DEST" ]]; then python3 -I "$CANDIDATE/compare-release.py" "$CANDIDATE/jeeta-release" "$DEST"; fi
CHANGED=1
# Production's existing upgrader takes its own verified recovery set, then fences/swaps/starts.
# Its brief old-release restart during backup never changes this wrapper's fail-closed policy.
if ! "$UPGRADE" "$ARCHIVE" "$REV" > "$BACKUP/upgrade.log" 2>&1; then fail 'audited upgrader failed; inspect protected upgrade.log'; fi
[[ $(readlink -f "$LINK") == "$DEST" && $(readlink -f "$OTHER_LINK") == "$OTHER_PREVIOUS" ]] || fail 'unexpected release pointer after publication'
python3 -I "$CANDIDATE/compare-release.py" "$CANDIDATE/jeeta-release" "$DEST"
check_digest "$(cat "$CANDIDATE/environment.sha256")" "$ENVFILE" || fail 'environment changed during publication'
systemctl is-active --quiet "$UNIT"
curl --fail --silent --show-error --max-time 10 --noproxy '*' -H "Host: $HOST" "http://127.0.0.1:$HTTP_PORT/readyz" > "$BACKUP/local-readyz"
curl --fail --silent --show-error --max-time 20 --noproxy '*' "https://$HOST/readyz" > "$BACKUP/public-readyz"
# A candidate without a migration leaves no trace in the database: say which binary serves.
# Printed, not enforced: the unit's start command is not this script's to assume.
SERVING=$(readlink -f "/proc/$(systemctl show "$UNIT" -p MainPID --value)/exe" 2>/dev/null || true)
printf 'Serving binary: %s (candidate: %s/jeeta)\n' "${SERVING:-unknown}" "$DEST"
migration_snapshot jeeta > "$BACKUP/published-migrations"
cmp "$CANDIDATE/expected-migrations" "$BACKUP/published-migrations"
install -d -m 0700 "$PROMOTIONS"
python3 -I - "$PROMOTIONS" "$ENVIRONMENT" "$REV" "$ARCHIVE_SHA256" "$BACKUP" <<'PY'
import datetime,json,os,pathlib,sys,tempfile
root,environment,revision,digest,backup=sys.argv[1:]
record={'environment':environment,'revision':revision,'archive_sha256':digest,'schema_version':40,'backup':backup,'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
fd,temp=tempfile.mkstemp(prefix='.promotion-',dir=root)
with os.fdopen(fd,'w') as f:json.dump(record,f);f.write('\n')
os.replace(temp,str(pathlib.Path(root)/(revision+'.'+environment+'.json')))
PY
printf 'Published %s at https://%s\nRevision: %s\nProtected recovery set: %s\nOther installation pointer unchanged: %s\n' "$ENVIRONMENT" "$HOST" "$REV" "$BACKUP" "$OTHER_PREVIOUS"
