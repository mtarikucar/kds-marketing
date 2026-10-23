//! [`AesSecretBox`]: HKDF-SHA256 per workspace, then AES-256-GCM (see the crate docs).

use std::fmt;

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, AeadInOut, KeyInit, Nonce, Payload};
use hkdf::Hkdf;
use jt_app::error::AppError;
use jt_app::ports::SecretBox;
use jt_tenancy::WorkspaceId;
use sha2::Sha256;
use zeroize::Zeroizing;

/// The first byte of every blob this version seals.
pub const FORMAT_VERSION: u8 = 0x01;
/// The HKDF salt; part of the format, like the version byte.
const SALT: &[u8] = b"jeeta-seal-v1";
/// The HKDF salt of the MAC keys ([`SecretBox::hmac_key`]): another salt than the sealing key's,
/// so the two derivations are independent whatever the info.
const HMAC_SALT: &[u8] = b"jeeta-hmac-v1";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// The version byte and the nonce.
const HEADER_LEN: usize = 1 + NONCE_LEN;
/// The one refusal `open` gives, whatever went wrong.
const REFUSED: &str = "sealed data cannot be opened";

/// The production secret box. `Debug` masks the master key, which is wiped when the box is
/// dropped.
pub struct AesSecretBox {
    master: Zeroizing<[u8; 32]>,
}

impl AesSecretBox {
    /// A box over the 32-byte master key.
    pub fn new(master: [u8; 32]) -> Self {
        AesSecretBox {
            master: Zeroizing::new(master),
        }
    }

    /// The cipher under `ws`'s key. The derived key lives in a buffer that is wiped on return.
    fn cipher(&self, ws: WorkspaceId) -> Result<Aes256Gcm, AppError> {
        let id = ws.as_uuid();
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(SALT), self.master.as_slice())
            .expand(id.as_bytes(), key.as_mut_slice())
            .map_err(|_| AppError::internal("cannot derive the workspace sealing key"))?;
        Aes256Gcm::new_from_slice(key.as_slice())
            .map_err(|_| AppError::internal("cannot derive the workspace sealing key"))
    }
}

/// The HKDF info of a MAC key: the workspace id's 16 bytes, a zero byte, then the purpose's UTF-8
/// bytes. The id has a fixed length, so no two (workspace, purpose) pairs share an info. Not
/// secret.
fn hmac_info(ws: WorkspaceId, purpose: &str) -> Vec<u8> {
    let id = ws.as_uuid();
    let mut info = Vec::with_capacity(16 + 1 + purpose.len());
    info.extend_from_slice(id.as_bytes());
    info.push(0);
    info.extend_from_slice(purpose.as_bytes());
    info
}

impl fmt::Debug for AesSecretBox {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AesSecretBox(***)")
    }
}

impl SecretBox for AesSecretBox {
    fn seal(&self, ws: WorkspaceId, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
        let cipher = self.cipher(ws)?;
        let mut nonce = [0u8; NONCE_LEN];
        rand::fill(&mut nonce);
        let id = ws.as_uuid();
        let ciphertext = cipher
            .encrypt(
                &Nonce::<Aes256Gcm>::from(nonce),
                Payload {
                    msg: plaintext,
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| AppError::internal("cannot seal the data"))?;
        let mut sealed = Vec::with_capacity(HEADER_LEN + ciphertext.len());
        sealed.push(FORMAT_VERSION);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&ciphertext);
        Ok(sealed)
    }

    fn open(&self, ws: WorkspaceId, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, AppError> {
        let refused = || AppError::internal(REFUSED);
        if sealed.len() < HEADER_LEN + TAG_LEN || sealed[0] != FORMAT_VERSION {
            return Err(refused());
        }
        let nonce: [u8; NONCE_LEN] = sealed[1..HEADER_LEN].try_into().map_err(|_| refused())?;
        let cipher = self.cipher(ws).map_err(|_| refused())?;
        let id = ws.as_uuid();
        // Decrypted in place, in a buffer that is wiped when dropped: on success it is the
        // plaintext handed back; on failure nothing that was in it outlives this call.
        let mut buffer = Zeroizing::new(sealed[HEADER_LEN..].to_vec());
        cipher
            .decrypt_in_place(
                &Nonce::<Aes256Gcm>::from(nonce),
                id.as_bytes(),
                &mut *buffer,
            )
            .map_err(|_| refused())?;
        Ok(buffer)
    }

    /// HKDF-SHA256 of the master key, salt `jeeta-hmac-v1`, info `workspace id (16 bytes) ||
    /// 0x00 || purpose` (see the crate docs).
    fn hmac_key(&self, ws: WorkspaceId, purpose: &str) -> Result<Zeroizing<[u8; 32]>, AppError> {
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(HMAC_SALT), self.master.as_slice())
            .expand(&hmac_info(ws, purpose), key.as_mut_slice())
            .map_err(|_| AppError::internal("cannot derive the workspace MAC key"))?;
        Ok(key)
    }
}
