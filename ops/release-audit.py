import pathlib, subprocess, json, shlex, urllib.parse, hashlib, tempfile, tarfile, re
facts={}
for label,root,envfile,unit in [('staging','/opt/jeeta/staging-current','/etc/jeeta-staging/jeeta.env','jeeta-staging.service'),('production','/opt/jeeta/current','/etc/jeeta/jeeta.env','jeeta.service')]:
    p=pathlib.Path(root); config={}
    for line in pathlib.Path(envfile).read_text().splitlines():
        if '=' not in line or line.lstrip().startswith('#'):continue
        k,v=line.split('=',1)
        if k in ('JEETA_DATABASE_URL','JEETA_FILES_DIR','JEETA_BIND','JEETA_PUBLIC_BASE_URL','JEETA_JOBS_ENABLED','JEETA_OUTREACH_ENABLED'):
            vs=shlex.split(v,comments=True)
            if vs:config[k]=vs[0]
    u=urllib.parse.urlparse(config.pop('JEETA_DATABASE_URL'))
    assert u.hostname in ('localhost','127.0.0.1')
    port=str(u.port or 5432);db=u.path.lstrip('/')
    q="SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version"
    rows=subprocess.check_output(['sudo','-u','postgres','psql','-XAt','-p',port,'-d',db,'-v','ON_ERROR_STOP=1','-c',q],text=True)
    facts[label]={'release':str(p.resolve()),'revision':(p/'REVISION').read_text().strip(),'database_port':port,'database_name':db,'selectors':config,'migrations':[r.split('|') for r in rows.splitlines()],'service':subprocess.check_output(['systemctl','is-active',unit],text=True).strip(),'manifest':json.loads((p/'manifest.json').read_text())}
    query=urllib.parse.parse_qsl(u.query)
    facts[label]['database_query_keys']=[key for key,_ in query]
    options=[]
    for key,value in query:
        if key!='options':continue
        for token in shlex.split(value):
            if token=='-c':continue
            option,sep,setting=token.removeprefix('-c').partition('=')
            safe=option.lower() in ('search_path','timezone','statement_timeout','lock_timeout','application_name') and bool(re.fullmatch(r'(?:public|UTC|jeeta|[0-9]+(?:ms|s|min)?)',setting))
            options.append({'name':option if re.fullmatch('[A-Za-z_]+',option) else 'nonstandard','value':setting if sep and safe else 'redacted'})
    facts[label]['database_options']=options
for path in ['/root/upgrade.sh','/root/staging-upgrade.sh','/etc/jeeta/recovery-control']:
    p=pathlib.Path(path);facts[path]={'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'size':p.stat().st_size}
facts['disk']=subprocess.check_output(['df','-h','/opt/jeeta','/var/backups'],text=True)
print(json.dumps(facts,indent=2))
# Existing scripts may contain private configuration. Transfer only encrypted, never log content.
with tempfile.TemporaryDirectory(prefix='jeeta-release-audit-') as tmp:
    tar=pathlib.Path(tmp)/'audit.tar'
    with tarfile.open(tar,'w') as out:
        for path in ['/root/upgrade.sh','/root/staging-upgrade.sh','/etc/systemd/system/jeeta.service','/etc/systemd/system/jeeta-staging.service','/etc/jeeta/recovery-control']:
            p=pathlib.Path(path)
            if p.is_file():out.add(p,arcname=p.name,recursive=False)
    subprocess.run(['openssl','cms','-encrypt','-binary','-aes256','-in',str(tar),'-outform','DER','-out','/root/jeeta-release-audit-dd66e8dc.p7m','/root/jeeta-release-audit-dd66e8dc.crt'],check=True)
