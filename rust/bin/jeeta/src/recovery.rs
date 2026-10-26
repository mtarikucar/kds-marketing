//! Recovery commands deliberately bypass server configuration, tracing, providers and jobs.
use jt_pg::recovery::Refused;
use jt_seal::AesSecretBox;
use std::{io::Read, os::unix::fs::MetadataExt, process::ExitCode, time::Duration};

fn key() -> Result<[u8; 32], Refused> {
    let raw = if let Ok(path) = std::env::var("JEETA_MASTER_KEY_FILE") {
        let meta = std::fs::symlink_metadata(&path).map_err(|_| Refused::Canary)?;
        if !meta.is_file() || meta.mode() & 0o077 != 0 || meta.len() > 128 {
            return Err(Refused::Canary);
        }
        let mut raw = String::new();
        std::fs::File::open(path)
            .map_err(|_| Refused::Canary)?
            .take(129)
            .read_to_string(&mut raw)
            .map_err(|_| Refused::Canary)?;
        raw
    } else {
        std::env::var("JEETA_SECRET_KEY").map_err(|_| Refused::Canary)?
    };
    let mut key = [0; 32];
    hex::decode_to_slice(raw.trim(), &mut key).map_err(|_| Refused::Canary)?;
    Ok(key)
}

pub fn run(operation: &str) -> ExitCode {
    let result = (|| {
        let secrets = AesSecretBox::new(key()?);
        let url = std::env::var("JEETA_DATABASE_URL").map_err(|_| Refused::Database)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| Refused::Database)?;
        let result = runtime
            .block_on(async {
                tokio::time::timeout(Duration::from_secs(15), async {
                    let pool = jt_pg::connect(&url).await.map_err(|_| Refused::Database)?;
                    let result = match operation {
                        "recovery-verify" => jt_pg::recovery::verify(&pool, &secrets).await,
                        _ => {
                            let ws = std::env::var("JEETA_RECOVERY_WORKSPACE_ID")
                                .ok()
                                .and_then(|s| s.parse().ok())
                                .ok_or(Refused::Canary)?;
                            if operation == "recovery-canary-up" {
                                jt_pg::recovery::seed_canary(&pool, ws, &secrets).await
                            } else {
                                jt_pg::recovery::remove_canary(&pool, ws).await
                            }
                        }
                    };
                    pool.close().await;
                    result
                })
                .await
            })
            .unwrap_or(Err(Refused::Database));
        runtime.shutdown_timeout(Duration::from_secs(1));
        result
    })();
    let category = match result {
        Ok(()) => "recovery: passed",
        Err(Refused::Database) => "recovery: database_failed",
        Err(Refused::Schema) => "recovery: schema_failed",
        Err(Refused::Rls) => "recovery: rls_failed",
        Err(Refused::Canary) => "recovery: canary_failed",
    };
    println!("{category}");
    if result.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
