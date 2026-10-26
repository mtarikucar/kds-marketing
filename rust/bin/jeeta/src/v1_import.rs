//! Offline command: no serve configuration, tracing subscriber, providers, jobs or migrations.
use jt_app::usecases::v1_import::{Lead, Mode};
use jt_tenancy::WorkspaceId;
use std::{
    ffi::OsString,
    fs::OpenOptions,
    io::{BufRead, BufReader},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::ExitCode,
};

pub struct Options {
    workspace: WorkspaceId,
    input: PathBuf,
    mode: Mode,
}
fn options(args: &[OsString]) -> Result<Options, &'static str> {
    let mut workspace = None;
    let mut input = None;
    let mut mode = Mode::Import;
    let mut i = 0;
    while i < args.len() {
        match args[i].to_str() {
            Some("--workspace") if workspace.is_none() => {
                i += 1;
                workspace = Some(
                    args.get(i)
                        .and_then(|v| v.to_str())
                        .and_then(|v| v.parse().ok())
                        .ok_or("arguments_invalid")?,
                );
            }
            Some("--input") if input.is_none() => {
                i += 1;
                input = Some(PathBuf::from(args.get(i).ok_or("arguments_invalid")?));
            }
            Some("--dry-run") if mode == Mode::Import => mode = Mode::DryRun,
            Some("--rollback") if mode == Mode::Import => mode = Mode::Rollback,
            _ => return Err("arguments_invalid"),
        }
        i += 1;
    }
    Ok(Options {
        workspace: workspace.ok_or("arguments_invalid")?,
        input: input.ok_or("arguments_invalid")?,
        mode,
    })
}

/// O_NOFOLLOW closes the final-component symlink race; O_NONBLOCK prevents FIFO hangs.
/// All content is bounded before JSON parsing and never included in error diagnostics.
pub fn read_input(path: &Path) -> Result<Vec<Lead>, &'static str> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "input_refused")?;
    let meta = file.metadata().map_err(|_| "input_refused")?;
    if !meta.is_file() || meta.len() > 256 * 1024 * 1024 {
        return Err("input_refused");
    }
    let mut reader = BufReader::new(file);
    let mut leads = Vec::new();
    let mut bytes = 0usize;
    loop {
        // The take limit also handles a file growing after metadata was checked.
        let mut line = Vec::new();
        let read = std::io::Read::take(&mut reader, 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| "input_invalid")?;
        if read == 0 {
            break;
        }
        bytes += read;
        if line.len() > 1024 * 1024 || bytes > 256 * 1024 * 1024 || leads.len() >= 1_000_000 {
            return Err("input_refused");
        }
        let lead: Lead = serde_json::from_slice(&line).map_err(|_| "input_invalid")?;
        lead.validate().map_err(|_| "input_invalid")?;
        leads.push(lead);
    }
    Ok(leads)
}

pub fn run(args: &[OsString]) -> ExitCode {
    let result = (|| {
        let opts = options(args)?;
        let leads = read_input(&opts.input)?;
        let key = std::env::var("JEETA_SECRET_KEY").map_err(|_| "configuration_failed")?;
        let mut decoded = [0u8; 32];
        hex::decode_to_slice(key.trim(), &mut decoded).map_err(|_| "configuration_failed")?;
        let url = std::env::var("JEETA_DATABASE_URL").map_err(|_| "configuration_failed")?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "runtime_failed")?;
        let result = runtime.block_on(async {
            let pool = jt_pg::connect(&url).await.map_err(|_| "database_failed")?;
            let result = async {
                jt_pg::recovery::check_schema(&pool, true)
                    .await
                    .map_err(|_| "schema_failed")?;
                jt_pg::recovery::check_rls(&pool)
                    .await
                    .map_err(|_| "rls_failed")?;
                jt_app::usecases::v1_import::run(
                    &jt_pg::v1_import::PgImportStore(pool.clone()),
                    opts.workspace,
                    &leads,
                    opts.mode,
                    time::OffsetDateTime::now_utc(),
                )
                .await
                .map_err(|error| match error.message.as_str() {
                    "v1 import already_running" => "already_running",
                    _ => "import_failed",
                })
            }
            .await;
            pool.close().await;
            result
        });
        runtime.shutdown_timeout(std::time::Duration::from_secs(1));
        result
    })();
    match result {
        Ok(report) => {
            println!(
                "{}",
                serde_json::to_string(&report).expect("counts serialize")
            );
            ExitCode::SUCCESS
        }
        Err(category) => {
            eprintln!("v1 import: {category}");
            ExitCode::FAILURE
        }
    }
}
