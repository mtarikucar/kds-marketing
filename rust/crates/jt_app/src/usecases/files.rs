//! What the workspace's file store (`ports::files::FileStore`) keeps: studio's media, checked by
//! studio's own rules (`studio::files::validate_upload`), and the files a device bridge uploads
//! (`devices::bridge`): a screenshot, which is a PNG image and so passes studio's rules, and a
//! file pulled off a phone, which can be anything. Studio's flows check its own rules on every file
//! they take, so a pulled file never becomes studio media.

use crate::error::AppError;
use crate::ports::connectors::MediaUpload;
use crate::usecases::studio::files::{VIDEO_LIMIT, invalid, validate_upload};

/// The type of a file a device bridge pulled off a phone: any bytes.
pub const OCTET_STREAM: &str = "application/octet-stream";
/// The most bytes of a file a device bridge uploads: 256 MiB, the most the bridge downloads for
/// `push_file`, so a file pulled off one phone can be pushed to another.
pub const DEVICE_FILE_LIMIT: u64 = 256 * 1024 * 1024;
/// The most bytes the file store keeps in one file: the largest of studio's video limit and
/// [`DEVICE_FILE_LIMIT`].
pub const STORED_LIMIT: u64 = if DEVICE_FILE_LIMIT > VIDEO_LIMIT {
    DEVICE_FILE_LIMIT
} else {
    VIDEO_LIMIT
};

/// Whether `name` can be a stored file's name: 1 to 255 bytes, no path separator, no control
/// character, neither `.` nor `..`.
pub fn filename_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
        && !matches!(name, "." | "..")
}

/// `Ok` for a file the store keeps: a pulled file ([`OCTET_STREAM`], at most
/// [`DEVICE_FILE_LIMIT`] bytes, empty too, with a [`filename_ok`] name), or what studio's
/// `validate_upload` takes. Else studio's `VALIDATION` "invalid media".
pub fn validate_stored(u: &MediaUpload) -> Result<(), AppError> {
    if u.mime != OCTET_STREAM {
        return validate_upload(u);
    }
    if u.bytes.len() as u64 > DEVICE_FILE_LIMIT || !filename_ok(&u.filename) {
        return Err(invalid());
    }
    Ok(())
}
