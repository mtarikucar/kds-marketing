# Jeeta — Rust çalışma alanı

Jeeta'nın Rust ile yeniden yazımı: tek ikili (`jeeta`), altıgen (hexagonal) mimaride ayrılmış crate'ler.
Tasarım belgesi: `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md`.

## Önkoşullar

- [rustup](https://rustup.rs). `rust-toolchain.toml` sürümü (1.96.0) ve `rustfmt`/`clippy` bileşenlerini
  ilk `cargo` çağrısında kendisi kurar.
- cargo-deny 0.19: `cargo install cargo-deny --locked`
- PostgreSQL 16 (Docker ile ya da yerel kurulum)
- Panel için Node 24 ve pnpm 9

## Kurulum

```sh
cd rust
cp .env.example .env   # .env git'e girmez; değerleri doldurun
```

## Test veritabanı

Veritabanına dokunan testler, `JEETA_TEST_DATABASE_URL` ile verilen yönetici (admin) adresindeki sunucuda
kendi geçici veritabanlarını açar ve siler. Docker ile yerel bir sunucu:

```sh
docker run -d --name jeeta-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
export JEETA_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

Testler bu değeri `.env` dosyasından değil, ortam değişkeninden okur.

## Denetimler

```sh
make check   # fmt + lint + deny + test
```

| Hedef | Komut |
|---|---|
| `make fmt` | `cargo fmt --all -- --check` |
| `make lint` | `cargo clippy --workspace --all-targets -- -D warnings` |
| `make deny` | `cargo deny check` |
| `make test` | `cargo test --workspace` |
| `make dev` | `cargo run -p jeeta -- serve` |
| `make panel-install` / `panel-test` / `panel-build` | `panel/` içinde pnpm |

## Sınırlar

Crate sınırları iki yerden denetlenir; ikisi de `make check` içinde çalışır:

- `crates/jt_archtest`: alan (domain) crate'leri (`jt_tenancy`, `jt_ledger`) yalnızca `serde`, `serde_json`,
  `uuid`, `time`, `thiserror` kullanır; `jt_app` hiçbir adaptöre bağlı değildir; `reqwest` yalnızca
  `jt_outbound`'da, `sqlx` yalnızca `jt_pg`'de (havuz kurmak için `jt_testkit` ve `jeeta`'da da) bulunur.
- `deny.toml`: aynı HTTP istemcisi ve `sqlx` kuralları ile yapay zekâ, medya üretimi, ses tanıma ve ses
  sentezi sağlayıcı kütüphanelerinin bağımlılık ağacının hiçbir yerinde bulunmaması; lisans, güvenlik
  bildirimi ve kaynak denetimleri.
