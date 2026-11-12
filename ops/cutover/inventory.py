# Read-only inventory for the jeetagrowth.com cutover. Prints only counts publicly;
# everything identifying goes into an encrypted bundle for the operator.
import json, os, pathlib, re, shlex, subprocess, tempfile, urllib.parse, hashlib


def sh(cmd):
    r = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True)
    return (r.stdout + (('\nERR:' + r.stderr) if r.returncode else '')).strip()


private, public = {}, {}
# --- nginx
vh = {}
for p in sorted(pathlib.Path('/etc/nginx/sites-enabled').iterdir()):
    try:
        t = p.resolve().read_text()
    except Exception as e:
        t = 'ERR ' + str(e)
    vh[p.name] = {'target': str(p.resolve()), 'server_names': re.findall(r'server_name\s+([^;]+);', t),
                  'proxy_pass': re.findall(r'proxy_pass\s+([^;]+);', t), 'root': re.findall(r'\broot\s+([^;]+);', t)}
private['nginx'] = vh
private['nginx_conf_files'] = {}
for p in list(pathlib.Path('/etc/nginx/sites-enabled').iterdir()) + list(pathlib.Path('/etc/nginx/conf.d').glob('*.conf')):
    try:
        t = p.resolve().read_text()
        if 'jeeta' in t:
            private['nginx_conf_files'][str(p)] = t
    except Exception:
        pass
public['nginx_vhosts'] = len(vh)
# --- systemd / pointers / docker
private['units'] = sh("systemctl list-units --all --no-pager --plain 'jeeta*' 'kds*'")
private['unit_files'] = {u: sh(['systemctl', 'cat', u]) for u in ['jeeta.service', 'jeeta-staging.service']}
private['pointers'] = {l: sh(['readlink', '-f', l]) for l in ['/opt/jeeta/current', '/opt/jeeta/staging-current']}
private['releases'] = sh('ls -la /opt/jeeta/releases')
private['docker'] = sh("docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'")
private['root_ls'] = sh('ls -la /root')
private['disk'] = sh('df -h / /var/backups /opt')
private['crontab'] = sh('crontab -l')
private['timers'] = sh('systemctl list-timers --all --no-pager')
private['root_scripts'] = sh('ls -la /root/*.sh /etc/jeeta')


# --- env key names (no values) + selected non-secret values
def envfile(path):
    vals = {}
    try:
        for line in pathlib.Path(path).read_text().splitlines():
            if '=' not in line or line.lstrip().startswith('#'):
                continue
            k, v = line.split('=', 1)
            try:
                vs = shlex.split(v, comments=True)
            except Exception:
                vs = [v]
            vals[k.strip()] = vs[0] if vs else ''
    except Exception as e:
        vals['__error__'] = str(e)
    return vals


envs = {'prod': envfile('/etc/jeeta/jeeta.env'), 'staging': envfile('/etc/jeeta-staging/jeeta.env')}
for cand in ['/root/kds-marketing/.env.production', '/root/kds-marketing/.env']:
    if os.path.exists(cand):
        envs['v1:' + cand] = envfile(cand)
NONSECRET = {'JEETA_PUBLIC_BASE_URL', 'JEETA_BIND', 'JEETA_JOBS_ENABLED', 'JEETA_OUTREACH_ENABLED', 'JEETA_META_APP_ID',
             'JEETA_INSTAGRAM_APP_ID', 'JEETA_META_GRAPH_VERSION', 'JEETA_META_COMMENT_SCOPES',
             'JEETA_INSTAGRAM_COMMENT_SCOPES', 'JEETA_ALLOWED_HOSTS', 'JEETA_FILES_DIR', 'JEETA_PANEL_DIR', 'META_APP_ID',
             'INSTAGRAM_APP_ID', 'PUBLIC_BASE_URL', 'FRONTEND_URL', 'APP_URL', 'CORS_ORIGIN', 'JEETA_LINKEDIN_ORG_SCOPES',
             'JEETA_META_LOGIN_CONFIG_ID', 'JEETA_META_WHATSAPP_CONFIG_ID', 'META_LOGIN_CONFIG_ID', 'JEETA_LOG',
             'JEETA_COOKIE_SECURE', 'JEETA_TIKTOK_CLIENT_KEY', 'JEETA_X_CLIENT_ID', 'JEETA_LINKEDIN_CLIENT_ID'}
private['env'] = {name: {k: (v if k in NONSECRET else ('set' if v else 'empty')) for k, v in e.items()}
                  for name, e in envs.items()}
private['env_secret_fingerprints'] = {
    name: {k: hashlib.sha256(v.encode()).hexdigest()[:10] for k, v in e.items() if v and re.search('SECRET|TOKEN|KEY|PASSWORD', k)}
    for name, e in envs.items()}


# --- Rust databases
def psql(port, db, q):
    return sh(['sudo', '-u', 'postgres', 'psql', '-XAt', '-F', '|', '-p', str(port), '-d', db, '-c', q])


dbs = {}
for label in ['prod', 'staging']:
    e = envs[label]
    u = urllib.parse.urlparse(e.get('JEETA_DATABASE_URL', ''))
    port, db = u.port or 5432, u.path.lstrip('/')
    d = {'port': port, 'db': db}
    d['migrations'] = psql(port, db, 'SELECT max(version), count(*) FROM _sqlx_migrations')
    d['workspace_cols'] = psql(port, db, "SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_name='workspaces'")
    d['workspaces'] = psql(port, db, "SELECT w.id, w.name, w.created_at::date, (SELECT count(*) FROM people p WHERE p.workspace_id=w.id), (SELECT count(*) FROM journeys j WHERE j.workspace_id=w.id), (SELECT count(*) FROM capabilities c WHERE c.workspace_id=w.id), (SELECT count(*) FROM memberships m WHERE m.workspace_id=w.id) FROM workspaces w ORDER BY 3")
    d['users'] = psql(port, db, 'SELECT count(*) FROM users')
    d['capabilities'] = psql(port, db, "SELECT workspace_id, kind_key, state, count(*) FROM capabilities GROUP BY 1,2,3 ORDER BY 1,2")
    d['ledger_cols'] = psql(port, db, "SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_name='ledger_entries'")
    d['v1_imports'] = psql(port, db, "SELECT * FROM ledger_entries WHERE to_jsonb(ledger_entries)::text LIKE '%import.v1%' LIMIT 20")
    d['size'] = psql(port, db, 'SELECT pg_size_pretty(pg_database_size(current_database()))')
    dbs[label] = d
    public[label + '_workspaces'] = len([l for l in d['workspaces'].splitlines() if l.count('|') >= 6])
private['dbs'] = dbs

# --- v1: dockerised postgres with a leads table
v1 = {}
for c in sh("docker ps --format '{{.Names}}'").split():
    if 'postgres' not in c and not c.endswith('_db'):
        continue
    for user in ['marketing', 'postgres']:
        out = sh(['docker', 'exec', c, 'psql', '-U', user, '-d', 'postgres', '-XAt', '-c', 'SELECT datname FROM pg_database WHERE NOT datistemplate'])
        if 'ERR:' in out:
            continue
        for dbn in out.split():
            has = sh(['docker', 'exec', c, 'psql', '-U', user, '-d', dbn, '-XAt', '-c',
                      "SELECT 1 FROM information_schema.tables WHERE table_name='leads' AND table_schema='public'"])
            if has.strip() != '1':
                continue
            q = ('SELECT w.id, w.slug, w.name, w.status, '
                 '(SELECT count(*) FROM leads l WHERE l."workspaceId"=w.id AND l."deletedAt" IS NULL AND l."mergedIntoId" IS NULL), '
                 '(SELECT count(*) FROM leads l WHERE l."workspaceId"=w.id), '
                 '(SELECT max(l."createdAt")::date FROM leads l WHERE l."workspaceId"=w.id) FROM workspaces w ORDER BY 5 DESC')
            v1[c + '/' + user + '/' + dbn] = {
                'workspaces': sh(['docker', 'exec', c, 'psql', '-U', user, '-d', dbn, '-XAt', '-F', '|', '-c', q]),
                'sources': sh(['docker', 'exec', c, 'psql', '-U', user, '-d', dbn, '-XAt', '-F', '|', '-c',
                               'SELECT "workspaceId", source, count(*) FROM leads WHERE "deletedAt" IS NULL AND "mergedIntoId" IS NULL GROUP BY 1,2 ORDER BY 1,3 DESC']),
                'status': sh(['docker', 'exec', c, 'psql', '-U', user, '-d', dbn, '-XAt', '-F', '|', '-c',
                              'SELECT "workspaceId", status, count(*) FROM leads WHERE "deletedAt" IS NULL AND "mergedIntoId" IS NULL GROUP BY 1,2 ORDER BY 1,2'])}
        break
private['v1'] = v1
public['v1_databases_with_leads'] = len(v1)

# --- encrypt
with tempfile.TemporaryDirectory() as tmp:
    p = pathlib.Path(tmp) / 'inv.json'
    p.write_text(json.dumps(private, indent=1, default=str))
    subprocess.run(['openssl', 'cms', '-encrypt', '-binary', '-aes256', '-in', str(p), '-outform', 'DER',
                    '-out', '/root/jeeta-inventory.p7m', '/root/jeeta-inventory.crt'], check=True)
print(json.dumps(public))
