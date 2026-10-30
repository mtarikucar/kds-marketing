//! Synthesised sentences, by the SHA-256 of the voice and the text: policy sentences (openings,
//! notice, phrases: owner-approved, no personal data) are kept on disk as raw PCM16 8 kHz; a call's
//! own sentences (its plan, the agent's) only in that call's memory, dropped at hang-up. The voice
//! is the speak service's voice id, from the `hello` it sends first on every connection (B2): it
//! names everything that decides how a text sounds, so audio of another voice is never played.
//!
//! On disk (B5 review): a file is written whole under a name of its writer's own, synced, then
//! renamed into place, so a crash or another writer (`run` and a `slice`) never leaves a short
//! file under a sentence's name; and a file that is empty or of an odd length all the same is a
//! miss, and is removed, so the sentence is synthesised and filed again instead of playing as
//! nothing for good.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

/// The cache key of `text` spoken by `voice`: 64 hex digits, also the file's name on disk.
pub fn key(voice: &str, text: &str) -> String {
    let mut h = Sha256::new();
    h.update(voice.as_bytes());
    h.update([0u8]);
    h.update(text.as_bytes());
    hex::encode(h.finalize())
}

/// Numbers this process's temporary files, so no two writes share one.
static WRITES: AtomicU64 = AtomicU64::new(0);

/// Writes `bytes` to `path`: whole under a temporary name of this write's own, synced to disk,
/// then renamed into place. A failed write leaves no temporary file behind.
fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let n = WRITES.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}.{n}.tmp", std::process::id()));
    let written = write_synced(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Creates `path` with `bytes`, synced to disk before it is closed.
fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
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

    /// The audio of `text`: from this call's memory, else from disk (then kept in memory too). A
    /// file that is empty or of an odd length is no PCM16 sentence: it is a miss, and is removed.
    pub fn get(&mut self, text: &str) -> Option<Arc<Vec<i16>>> {
        let k = key(&self.voice, text);
        if let Some(pcm) = self.memory.get(&k) {
            return Some(pcm.clone());
        }
        let path = self.dir.join(format!("{k}.pcm"));
        let bytes = std::fs::read(&path).ok()?;
        if bytes.is_empty() || bytes.len() % 2 != 0 {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        let pcm: Arc<Vec<i16>> = Arc::new(
            bytes
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect(),
        );
        self.memory.insert(k, pcm.clone());
        Some(pcm)
    }

    /// Keeps `pcm`, spoken by `voice`, as the audio of `text`: in memory, and on disk too when
    /// `persist` (a policy sentence). Audio of a voice other than the cache's is dropped (a late
    /// pre-synthesis of the voice the call started with, after the speak service was replaced). An
    /// error is the disk's: the sentence is still kept in memory, so the call plays it and may warn.
    pub fn put(
        &mut self,
        voice: &str,
        text: &str,
        pcm: Vec<i16>,
        persist: bool,
    ) -> std::io::Result<()> {
        if voice != self.voice {
            return Ok(());
        }
        let k = key(&self.voice, text);
        let filed = if persist && !pcm.is_empty() {
            let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
            std::fs::create_dir_all(&self.dir)
                .and_then(|()| write_whole(&self.dir.join(format!("{k}.pcm")), &bytes))
        } else {
            Ok(())
        };
        self.memory.insert(k, Arc::new(pcm));
        filed
    }
}
