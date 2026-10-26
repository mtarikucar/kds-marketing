use std::process::Command;
#[test]
fn bootstrap_reset_requires_explicit_flag_and_credentials() {
    for (flag, email, password, expected) in [
        ("1", None, None, "JEETA_PLATFORM_BOOTSTRAP"),
        ("true", None, None, "JEETA_PLATFORM_BOOTSTRAP_RESET"),
        (
            "1",
            Some("operator@example.test"),
            Some("short"),
            "JEETA_PLATFORM_BOOTSTRAP_PASSWORD",
        ),
        (
            "0",
            Some("operator@example.test"),
            None,
            "JEETA_PLATFORM_BOOTSTRAP_PASSWORD",
        ),
    ] {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_jeeta"));
        cmd.current_dir(std::env::temp_dir())
            .env_clear()
            .env(
                "JEETA_DATABASE_URL",
                "postgres://synthetic@127.0.0.1:1/unavailable",
            )
            .env("JEETA_SECRET_KEY", "ab".repeat(32))
            .env("JEETA_PRICE_MINOR", "123")
            .env("JEETA_PRICE_CURRENCY", "TRY")
            .env("JEETA_BANK_INSTRUCTIONS", "synthetic")
            .env("JEETA_METRICS_TOKEN", "synthetic")
            .env("JEETA_PLATFORM_BOOTSTRAP_RESET", flag)
            .arg("serve");
        if let Some(v) = email {
            cmd.env("JEETA_PLATFORM_BOOTSTRAP_EMAIL", v);
        }
        if let Some(v) = password {
            cmd.env("JEETA_PLATFORM_BOOTSTRAP_PASSWORD", v);
        }
        let out = cmd.output().unwrap();
        assert!(!out.status.success());
        assert!(String::from_utf8(out.stderr).unwrap().contains(expected));
    }
}

#[tokio::test]
async fn startup_reset_is_explicit_and_revokes_sessions() {
    use jt_app::{
        ports::PasswordHasher,
        std_impls::Argon2Hasher,
        usecases::{auth::LoginInput, platform},
    };
    use sqlx::ConnectOptions;
    use std::sync::Arc;
    let db = jt_testkit::TestDb::new().await;
    let mut d = jt_testkit::fakes::deps(Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())));
    d.hasher = Arc::new(Argon2Hasher::default());
    let files = std::env::temp_dir().join(format!("{}-files", db.name()));
    std::fs::create_dir(&files).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&files, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let old = "synthetic old password";
    let new = "synthetic replacement password";
    platform::bootstrap(&d, "operator@example.test", old)
        .await
        .unwrap();
    let login = platform::login(
        &d,
        LoginInput {
            email: "operator@example.test".into(),
            password: old.into(),
        },
    )
    .await
    .unwrap();
    // Occupy the listener: boot must reach bind after applying recovery, then exit promptly.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    for flag in [None, Some("0"), Some("1")] {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_jeeta"));
        cmd.current_dir(std::env::temp_dir())
            .env_clear()
            .env(
                "JEETA_DATABASE_URL",
                db.connect_options().to_url_lossy().as_str(),
            )
            .env("JEETA_SECRET_KEY", "ab".repeat(32))
            .env("JEETA_PRICE_MINOR", "123")
            .env("JEETA_PRICE_CURRENCY", "TRY")
            .env("JEETA_BANK_INSTRUCTIONS", "synthetic")
            .env("JEETA_METRICS_TOKEN", "synthetic")
            .env("JEETA_ALLOW_TEST_LOOPBACK", "true")
            .env("JEETA_FILES_DIR", &files)
            .env("JEETA_PUBLIC_BASE_URL", "https://panel.example.test")
            .env("JEETA_BIND", listener.local_addr().unwrap().to_string())
            .env("JEETA_PLATFORM_BOOTSTRAP_EMAIL", "operator@example.test")
            .env("JEETA_PLATFORM_BOOTSTRAP_PASSWORD", new)
            .arg("serve");
        if let Some(v) = flag {
            cmd.env("JEETA_PLATFORM_BOOTSTRAP_RESET", v);
        }
        let out = cmd.output().unwrap();
        assert!(!out.status.success());
        let stderr = String::from_utf8(out.stderr).unwrap();
        assert!(
            stderr.contains(if flag == Some("1") {
                "operator password reset"
            } else {
                "platform operator already present"
            }),
            "boot did not reach bind: {stderr}"
        );
        assert!(!stderr.contains(old));
        assert!(!stderr.contains(new));
        assert!(!stderr.contains("$argon2"));
        let mut r = d.uow.platform().await.unwrap();
        let row = r
            .operators()
            .find_by_email(&jt_tenancy::Email::parse("operator@example.test").unwrap())
            .await
            .unwrap()
            .unwrap();
        drop(r);
        assert!(
            Argon2Hasher::default()
                .verify(
                    if flag == Some("1") { new } else { old },
                    &row.password_hash
                )
                .await
                .unwrap()
        );
        assert_eq!(
            platform::resolve(&d, &login.token).await.is_ok(),
            flag != Some("1")
        );
    }
    std::fs::remove_dir_all(files).unwrap();
}
