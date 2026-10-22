//! The `SecretBox` adapter: secrets sealed with AES-256-GCM under a key of their own workspace.
//!
//! Each workspace's key is derived from the master key (`JEETA_SECRET_KEY`, 32 bytes) with
//! HKDF-SHA256: salt `jeeta-seal-v1`, info the workspace id's 16 bytes. Only the master key is
//! kept; a workspace key exists only while one `seal` or `open` call runs and is wiped after it.
//!
//! A sealed blob is `v || nonce || ciphertext`:
//!
//! | bytes | content |
//! |---|---|
//! | 1 | format version, `0x01` |
//! | 12 | a fresh random 96-bit nonce, drawn for every seal |
//! | plaintext length + 16 | the AES-256-GCM ciphertext followed by its 128-bit tag |
//!
//! The workspace id is also the GCM associated data. A blob therefore opens only for the
//! workspace it was sealed for, on two independent grounds: another workspace derives another
//! key, and even with the same key material the tag would not verify under another workspace id
//! (a blob copied into another workspace's row is refused, not decrypted).
//!
//! Random 96-bit nonces stay far below the GCM collision bound for the number of secrets one
//! workspace key will ever seal (connector credentials, not a message stream).

mod aes;

pub use aes::{AesSecretBox, FORMAT_VERSION};
