//! Streaming SEARCH framing below async-imap, whose parser buffers whole SEARCH responses
//! and does not support ESEARCH. Only active during a discovery command; MIME stays opaque.
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

pub(crate) const SEARCH_HITS: usize = 1_000;
pub(crate) struct SearchRead<T> {
    inner: T,
    remaining: usize,
    input: [u8; 8192],
    start: usize,
    end: usize,
    output: Vec<u8>,
    sent: usize,
    line: Vec<u8>,
    forwarded_prefix: usize,
    normal_response: bool,
    prefix_needed: usize,
    query: Option<(String, bool)>,
    seen: bool,
    overflow: bool,
    search_line: bool,
    cr: bool,
    number: u32,
    digits: bool,
    hits: Vec<u32>,
}
impl<T> std::fmt::Debug for SearchRead<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SearchRead")
    }
}
fn invalid() -> io::Error {
    io::Error::other("invalid mail search response")
}
impl<T> SearchRead<T> {
    pub(crate) fn new(inner: T, remaining: usize) -> Self {
        Self {
            inner,
            remaining,
            input: [0; 8192],
            start: 0,
            end: 0,
            output: Vec::new(),
            sent: 0,
            line: Vec::new(),
            forwarded_prefix: 0,
            normal_response: false,
            prefix_needed: 0,
            query: None,
            seen: false,
            overflow: false,
            search_line: false,
            cr: false,
            number: 0,
            digits: false,
            hits: Vec::new(),
        }
    }
    pub(crate) fn begin(&mut self, tag: String, esearch: bool, prefix: &[u8]) {
        self.line.extend_from_slice(prefix);
        self.forwarded_prefix = prefix.len();
        self.normal_response = !prefix.is_empty();
        self.prefix_needed = 0;
        self.query = Some((tag, esearch));
        self.seen = false;
        self.overflow = false;
    }
    pub(crate) fn finish(&mut self) -> io::Result<bool> {
        self.query = None;
        if !self.seen {
            return Err(invalid());
        }
        Ok(self.overflow)
    }
    fn number_end(&mut self) -> io::Result<()> {
        if self.digits {
            if self.number == 0 {
                return Err(invalid());
            }
            if self.hits.len() < SEARCH_HITS {
                self.hits.push(self.number);
            } else {
                self.overflow = true;
            }
            self.number = 0;
            self.digits = false;
        }
        Ok(())
    }
    fn emit_search(&mut self) {
        self.output.extend_from_slice(b"* SEARCH");
        if !self.overflow {
            for uid in &self.hits {
                self.output.extend_from_slice(format!(" {uid}").as_bytes());
            }
        }
        self.output.extend_from_slice(b"\r\n");
        self.hits.clear();
        self.search_line = false;
        self.cr = false;
        self.seen = true;
    }
    fn esearch(&mut self) -> io::Result<()> {
        let (tag, enabled) = self.query.as_ref().ok_or_else(invalid)?;
        if !enabled || self.seen {
            return Err(invalid());
        }
        let text = std::str::from_utf8(&self.line).map_err(|_| invalid())?;
        let mut words = text.split_ascii_whitespace().skip(2);
        let mut word = words.next().ok_or_else(invalid)?;
        if word.eq_ignore_ascii_case("(TAG") {
            if words.next() != Some(format!("\"{tag}\")").as_str()) {
                return Err(invalid());
            }
            word = words.next().ok_or_else(invalid)?;
        }
        if !word.eq_ignore_ascii_case("UID") {
            return Err(invalid());
        }
        if let Some(option) = words.next() {
            if !option.eq_ignore_ascii_case("MIN") {
                return Err(invalid());
            }
            let uid: u32 = words
                .next()
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?;
            if uid == 0 || words.next().is_some() {
                return Err(invalid());
            }
            self.hits.push(uid);
        }
        self.emit_search();
        Ok(())
    }
    // Complete ordinary responses using the protocol grammar, including opaque literals.
    // For a response started before begin(), emit only bytes not already forwarded.
    fn normal(&mut self, byte: u8) -> io::Result<()> {
        let limit = crate::MAX_MESSAGE_BYTES + 64 * 1024;
        if self.line.len() > limit {
            return Err(invalid());
        }
        if self.line.len() < self.prefix_needed || (self.prefix_needed == 0 && byte != b'\n') {
            return Ok(());
        }
        match async_imap::imap_proto::parser::parse_response(&self.line) {
            Ok(([], _)) => {
                self.output
                    .extend_from_slice(&self.line[self.forwarded_prefix..]);
                self.line.clear();
                self.forwarded_prefix = 0;
                self.normal_response = false;
                self.prefix_needed = 0;
            }
            Err(nom::Err::Incomplete(nom::Needed::Size(extra))) => {
                self.prefix_needed = self.line.len().saturating_add(extra.get());
                if self.prefix_needed > limit {
                    return Err(invalid());
                }
            }
            Err(nom::Err::Incomplete(nom::Needed::Unknown)) => self.prefix_needed = 0,
            _ => return Err(invalid()),
        }
        Ok(())
    }
    fn byte(&mut self, byte: u8) -> io::Result<()> {
        if self.normal_response {
            self.line.push(byte);
            return self.normal(byte);
        }
        if self.search_line {
            match byte {
                b'0'..=b'9' if !self.cr => {
                    self.number = self
                        .number
                        .checked_mul(10)
                        .and_then(|n| n.checked_add((byte - b'0') as u32))
                        .ok_or_else(invalid)?;
                    self.digits = true;
                }
                b' ' if !self.cr => self.number_end()?,
                b'\r' if !self.cr => {
                    self.number_end()?;
                    self.cr = true;
                }
                b'\n' if self.cr => self.emit_search(),
                _ => return Err(invalid()),
            }
            return Ok(());
        }
        self.line.push(byte);
        if self.line.len() == 9
            && self.line[..8].eq_ignore_ascii_case(b"* SEARCH")
            && matches!(byte, b' ' | b'\r')
        {
            if self.seen || self.query.as_ref().is_some_and(|(_, esearch)| *esearch) {
                return Err(invalid());
            }
            self.search_line = true;
            self.cr = byte == b'\r';
            self.line.clear();
        } else if self.line.len() > 64 * 1024 {
            return Err(invalid());
        } else if byte == b'\n' {
            if !self.line.ends_with(b"\r\n") {
                return Err(invalid());
            }
            if self.line.len() >= 10 && self.line[..10].eq_ignore_ascii_case(b"* ESEARCH ") {
                self.esearch()?;
            } else {
                self.normal_response = true;
                return self.normal(byte);
            }
            self.line.clear();
        }
        Ok(())
    }
}
impl<T: AsyncRead + Unpin> AsyncRead for SearchRead<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let mut processed = 0;
        loop {
            if self.sent < self.output.len() {
                let count = buf.remaining().min(self.output.len() - self.sent);
                buf.put_slice(&self.output[self.sent..self.sent + count]);
                self.sent += count;
                return Poll::Ready(Ok(()));
            }
            self.output.clear();
            self.sent = 0;
            if self.start < self.end {
                if self.query.is_none() {
                    let count = buf.remaining().min(self.end - self.start);
                    buf.put_slice(&self.input[self.start..self.start + count]);
                    self.start += count;
                    return Poll::Ready(Ok(()));
                }
                let byte = self.input[self.start];
                self.start += 1;
                self.byte(byte)?;
                processed += 1;
                // Yield while draining large responses, so the operation timeout can fire.
                if processed >= 64 * 1024 {
                    cx.waker().wake_by_ref();
                    return Poll::Pending;
                }
                continue;
            }
            if self.remaining == 0 {
                return Poll::Ready(Err(io::Error::other("mail read limit exceeded")));
            }
            let this = &mut *self;
            let mut incoming = ReadBuf::new(&mut this.input[..this.remaining.min(8192)]);
            match Pin::new(&mut this.inner).poll_read(cx, &mut incoming) {
                Poll::Ready(Ok(())) => {
                    let count = incoming.filled().len();
                    this.remaining -= count;
                    this.start = 0;
                    this.end = count;
                    if count == 0 {
                        return Poll::Ready(if this.line.is_empty() && !this.search_line {
                            Ok(())
                        } else {
                            Err(invalid())
                        });
                    }
                }
                other => return other,
            }
        }
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for SearchRead<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
