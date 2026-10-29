//! Synthesised sentences, by the SHA-256 of the voice and the text: policy sentences (openings,
//! notice, phrases: owner-approved, no personal data) are kept on disk as raw PCM16 8 kHz; a call's
//! own sentences (its plan, the agent's) only in that call's memory, dropped at hang-up. The voice
//! is the speak service's voice id, from the `hello` it sends first on every connection (B2): it
//! names everything that decides how a text sounds, so audio of another voice is never played.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use sha2::{Digest, Sha256};

/// The cache key of `text` spoken by `voice`: 64 hex digits, also the file's name on disk.
pub fn key(voice: &str, text: &str) -> String {
    let mut h = Sha256::new();
    h.update(voice.as_bytes());
    h.update([0u8]);
    h.update(text.as_bytes());
    hex::encode(h.finalize())
}

/// One call's audio by sentence, over the shared disk cache of the policy's sentences.
pub struct PhraseCache {
    dir: PathBuf,
    voice: String,
    memory: HashMap<String, Arc<Vec<i16>>>,
}

impl PhraseCache {
    pub fn new(dir: PathBuf, voice: &str) -> PhraseCache {
        PhraseCache {
            dir,
            voice: voice.to_owned(),
            memory: HashMap::new(),
        }
    }

    /// The voice id this cache keys by.
    pub fn voice(&self) -> &str {
        &self.voice
    }

    /// The audio of `text`: from this call's memory, else from disk (then kept in memory too).
    pub fn get(&mut self, text: &str) -> Option<Arc<Vec<i16>>> {
        let k = key(&self.voice, text);
        if let Some(pcm) = self.memory.get(&k) {
            return Some(pcm.clone());
        }
        let bytes = std::fs::read(self.dir.join(format!("{k}.pcm"))).ok()?;
        let pcm: Arc<Vec<i16>> = Arc::new(
            bytes
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect(),
        );
        self.memory.insert(k, pcm.clone());
        Some(pcm)
    }

    /// Keeps `pcm` as the audio of `text`; on disk too when `persist` (a policy sentence). The
    /// file is written beside its name and renamed into place, so a reader never sees half of it;
    /// a write that fails leaves the sentence in memory only.
    pub fn put(&mut self, text: &str, pcm: Vec<i16>, persist: bool) {
        let k = key(&self.voice, text);
        if persist && std::fs::create_dir_all(&self.dir).is_ok() {
            let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
            let tmp = self.dir.join(format!("{k}.tmp"));
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, self.dir.join(format!("{k}.pcm")));
            }
        }
        self.memory.insert(k, Arc::new(pcm));
    }
}
