#!/usr/bin/env bash
# One authorized staging promotion. No production writes or schema migrations.
set -euo pipefail
umask 077
REV=01194c8567db522d4fa9523b9b659a04023c58e5
ARCHIVE=/root/jeeta-release-01194c85.tar
EXPECTED=cc0f136d3f2661ee044692abcd107d3140f09fae72a0f75ba0ac6bc4fb5e8de7
UPGRADE_HASH=120ff74c1b8ae34cc6f9a23328b5425f2c67818a4b9a3b32fd56a9c3b5935929
printf '%s  %s\n' "$EXPECTED" "$ARCHIVE" | sha256sum --check --status
printf '%s  %s\n' "$UPGRADE_HASH" /root/staging-upgrade.sh | sha256sum --check --status
systemctl is-active --quiet jeeta-staging.service
PREVIOUS=$(readlink -f /opt/jeeta/staging-current)
PRODUCTION=$(readlink -f /opt/jeeta/current)
test -s "$PREVIOUS/REVISION"
CANDIDATE=$(mktemp -d /root/jeeta-staging-candidate.XXXXXX)
trap 'rm -rf -- "$CANDIDATE"' EXIT
python3 - "$ARCHIVE" "$CANDIDATE" "$REV" <<'PY'
import tarfile,sys,pathlib,json,hashlib,subprocess,shlex,urllib.parse
archive,dest,rev=sys.argv[1:]
with tarfile.open(archive) as t:
    for member in t.getmembers():
        p=pathlib.PurePosixPath(member.name)
        assert p.parts[0]=='jeeta-release' and '..' not in p.parts and not p.is_absolute()
        assert member.isfile() or member.isdir()
    t.extractall(dest)
r=pathlib.Path(dest)/'jeeta-release';m=json.loads((r/'manifest.json').read_text())
assert m['source_revision']==rev and m['source_clean']
assert (r/'REVISION').read_text().strip()==rev
assert hashlib.sha256((r/'jeeta').read_bytes()).hexdigest()==m['binary_checksum']['value']
assert hashlib.sha256((r/'panel.sha256').read_bytes()).hexdigest()==m['panel_checksum']['value']
subprocess.run(['sha256sum','--check','--quiet','panel.sha256'],cwd=r,check=True)
for migration in m['migrations']:
    for direction in ('up','down'):
        assert hashlib.sha384((r/'migrations'/migration[direction]).read_bytes()).hexdigest()==migration[direction+'_sha384']
# Read only the configuration selectors needed to prove this is the staging DB/files.
# No credential values are printed or passed on the command line.
selectors={}
for line in pathlib.Path('/etc/jeeta-staging/jeeta.env').read_text().splitlines():
    if '=' not in line or line.lstrip().startswith('#'):continue
    key,value=line.split('=',1)
    if key in ('JEETA_DATABASE_URL','JEETA_FILES_DIR','JEETA_BIND','JEETA_PUBLIC_BASE_URL'):
        parts=shlex.split(value,comments=True);assert len(parts)==1;selectors[key]=parts[0]
u=urllib.parse.urlparse(selectors['JEETA_DATABASE_URL'])
assert u.hostname in ('localhost','127.0.0.1') and u.port==5437 and u.path=='/jeeta'
assert selectors['JEETA_BIND']=='127.0.0.1:8091'
assert selectors['JEETA_PUBLIC_BASE_URL']=='https://staging.jeetagrowth.com'
files=pathlib.Path(selectors['JEETA_FILES_DIR'])
assert files.is_dir() and not files.is_symlink()
assert str(files.resolve()).startswith('/var/lib/jeeta-staging/')
(pathlib.Path(dest)/'files-path').write_text(str(files.resolve()))
rows=subprocess.check_output(['sudo','-u','postgres','psql','-XAt','-p','5437','-d','jeeta','-v','ON_ERROR_STOP=1','-c',"SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version"],text=True)
actual=[line.split('|') for line in rows.splitlines()]
expected=[[str(x['version']),x['up_sha384'],'t'] for x in m['migrations']]
assert actual==expected, 'Staging schema differs: migration review required before any service change'
(pathlib.Path(dest)/'database-migrations').write_text(rows)
print('Candidate files verified; staging database and migration inventory match exactly')
PY
# Prevent concurrent copies of this staging operation.
exec 9>/run/jeeta-staging-publish.lock
flock -n 9
BACKUP=/var/backups/jeeta-staging/pre-01194c85-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$BACKUP"
FILES=$(cat "$CANDIDATE/files-path")
# Stopping staging fences its HTTP ingress and in-process writers for a consistent snapshot.
CHANGED=0
recover_before_swap() {
  local rc=$?
  if (( rc != 0 )) && (( CHANGED == 0 )); then systemctl start jeeta-staging.service || true; fi
  rm -rf -- "$CANDIDATE"
  exit "$rc"
}
trap recover_before_swap EXIT
test "$(readlink -f /opt/jeeta/staging-current)" = "$PREVIOUS"
test "$(readlink -f /opt/jeeta/current)" = "$PRODUCTION"
systemctl stop jeeta-staging.service
sudo -u postgres psql -XAt -p 5437 -d jeeta -v ON_ERROR_STOP=1 -c "SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version" > "$CANDIDATE/stopped-migrations"
cmp "$CANDIDATE/database-migrations" "$CANDIDATE/stopped-migrations"
sudo -u postgres pg_dump -p 5437 -Fc jeeta > "$BACKUP/database.dump"
pg_restore --list "$BACKUP/database.dump" > "$BACKUP/database.contents"
test -s "$BACKUP/database.contents"
tar -C "$FILES" -cf "$BACKUP/files.tar" .
tar -tf "$BACKUP/files.tar" > "$BACKUP/files.contents"
install -m 0600 /etc/jeeta-staging/jeeta.env "$BACKUP/jeeta.env"
cp "$PREVIOUS/manifest.json" "$PREVIOUS/REVISION" "$BACKUP/"
cp "$CANDIDATE/database-migrations" "$BACKUP/database-migrations"
# Validate the logical dump by restoring only into a fresh isolated temporary database.
VERIFY_DB=jeeta_verify_01194c85_$(date +%s)
sudo -u postgres createdb -p 5437 "$VERIFY_DB"
if ! sudo -u postgres pg_restore -p 5437 --exit-on-error --no-owner -d "$VERIFY_DB" < "$BACKUP/database.dump" > "$BACKUP/restore.log" 2>&1; then
  echo "::error::Backup restore verification failed; preserved isolated database for inspection"
  exit 1
fi
sudo -u postgres psql -XAt -p 5437 -d "$VERIFY_DB" -v ON_ERROR_STOP=1 -c "SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version" > "$BACKUP/restored-migrations"
cmp "$BACKUP/database-migrations" "$BACKUP/restored-migrations"
sudo -u postgres dropdb -p 5437 "$VERIFY_DB"
(cd "$BACKUP" && sha256sum database.dump files.tar jeeta.env manifest.json REVISION database-migrations > SHA256SUMS && sha256sum --check --status SHA256SUMS)
# Never reuse an unverified pre-existing release directory.
if test -e "/opt/jeeta/releases/$REV"; then
  cmp "$CANDIDATE/jeeta-release/manifest.json" "/opt/jeeta/releases/$REV/manifest.json"
  cmp "$CANDIDATE/jeeta-release/jeeta" "/opt/jeeta/releases/$REV/jeeta"
  cmp "$CANDIDATE/jeeta-release/panel.sha256" "/opt/jeeta/releases/$REV/panel.sha256"
  diff -qr "$CANDIDATE/jeeta-release/migrations" "/opt/jeeta/releases/$REV/migrations"
  (cd "/opt/jeeta/releases/$REV" && sha256sum --check --quiet panel.sha256)
fi
CHANGED=1
/root/staging-upgrade.sh "$ARCHIVE" "$REV"
test "$(readlink -f /opt/jeeta/staging-current)" = "/opt/jeeta/releases/$REV"
test "$(readlink -f /opt/jeeta/current)" = "$PRODUCTION"
systemctl is-active --quiet jeeta-staging.service
curl --fail --silent --show-error -H 'Host: staging.jeetagrowth.com' http://127.0.0.1:8091/readyz
curl --fail --silent --show-error https://staging.jeetagrowth.com/readyz
printf '\nPublished staging revision: %s\nRecovery set: %s\nProduction revision unchanged: %s\n' "$REV" "$BACKUP" "$(basename "$PRODUCTION")"
