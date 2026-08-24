//! The frames the app and the pty daemon exchange over their unix socket.
//!
//! Length-prefixed rather than newline-delimited, because half of what crosses
//! here is raw pty output: arbitrary bytes, newlines included, and no encoding
//! step that would survive being run on every keystroke and every frame of a
//! redrawing TUI. A four-byte length and a tag is the whole envelope.
//!
//! The two directions use separate tag spaces — `C_*` for what the app sends,
//! `D_*` for what the daemon sends back — so a frame is never ambiguous about
//! which way it was going, which matters when reading a packet capture or a
//! log of a session that misbehaved.

use std::io::{self, Read, Write};

/// The version of everything below, and part of the socket's name.
///
/// An app update replaces the binary while a daemon from the old one is still
/// holding shells, so the two ends of this socket are routinely built months
/// apart. Negotiating that in-band is the obvious design and the wrong one:
/// the failure it has to survive is an *older* daemon, which by definition
/// does not know how to be asked. Naming the socket after the version instead
/// means a new app never reaches an old daemon at all — it starts its own, and
/// the old one drains its sessions and exits on the same grace clock as ever.
///
/// The cost is that sessions do not survive the one update that bumps this.
/// That is worth being deliberate about: bump it only for a change that would
/// actually confuse an old daemon, not for every new tag.
///
/// There is a second reason to bump it, learned from the release that added
/// scrollback to the replay: **a change inside the daemon does not ship with
/// the app.** The daemon is a process, not a library — an update replaces the
/// binary, the new app finds the old daemon still listening on a socket named
/// the same, and joins it. Everything the update changed about how sessions
/// are held goes on not happening, for as long as that daemon lives, which
/// with a dozen shells open is forever. Whether the two ends can still talk is
/// not the question; whether the old one is still the right one to be holding
/// the shells is. When it isn't, this is the only lever that moves them.
pub const VERSION: u32 = 3;

// ── app → daemon ─────────────────────────────────────────────────────────────

/// JSON `{req, id, cwd, cols, rows}`. Answered with `D_REPLY`.
pub const C_SPAWN: u8 = 1;
/// `u16` id length, the id, then the bytes to write. Not answered: a keystroke
/// that had to wait for a round trip would be a keystroke you could feel.
pub const C_WRITE: u8 = 2;
/// JSON `{id, cols, rows}`. Not answered.
pub const C_RESIZE: u8 = 3;
/// JSON `{id}`. Not answered.
pub const C_KILL: u8 = 4;
/// Empty body. Not answered.
pub const C_KILL_ALL: u8 = 5;
/// JSON `{req}`. Answered with `D_REPLY` carrying `status`.
pub const C_STATUS: u8 = 6;
/// JSON `{app: bool, req}`, sent once on connecting, and **answered**.
///
/// The answer is what tells the app the daemon is really serving rather than
/// merely listening: `reaper` calls `process::exit` the moment it is empty and
/// past the grace window, so a connect can succeed against a socket that is
/// about to EOF. Without a round trip the app would boot, find its client dead
/// on the first frame, and have no terminals until it was restarted — the one
/// outcome this whole feature exists to prevent. Only a connection that says
/// `app` receives output and holds the grace clock open; everything else is a
/// control client — `zero --sessions` and friends — which may come and go
/// while the app is attached without disturbing it.
pub const C_HELLO: u8 = 8;
/// JSON `{req, keep: [id, ...]}` — end every session no restored layout claims.
/// Answered, so the app can finish booting knowing the orphans are gone.
pub const C_REAP: u8 = 7;

// ── daemon → app ─────────────────────────────────────────────────────────────

/// `u16` id length, the id, then the bytes the shell printed.
pub const D_OUTPUT: u8 = 1;
/// JSON `{id}` — the shell exited on its own.
pub const D_EXIT: u8 = 2;
/// JSON `{req, error, status}` — the answer to whichever request carried `req`.
pub const D_REPLY: u8 = 3;

/// Frames above this are a desync or a hostile peer, not a terminal. The pty
/// reader hands over 8 KiB at a time, so this is three orders of magnitude of
/// headroom and still small enough that a bad length can't ask for an
/// allocation that matters.
const FRAME_MAX: usize = 16 * 1024 * 1024;

/// One frame, written whole. The caller holds the lock that makes this atomic
/// against other writers — interleaving two frames' bytes would desync the
/// stream permanently, and there is no resynchronising from it.
pub fn write_frame(w: &mut impl Write, tag: u8, body: &[u8]) -> io::Result<()> {
    let len = (body.len() + 1) as u32;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(&[tag])?;
    w.write_all(body)?;
    w.flush()
}

/// Blocks until a whole frame has arrived. `UnexpectedEof` on a clean close is
/// how both sides learn the other has gone.
pub fn read_frame(r: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > FRAME_MAX {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame length"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    let tag = body.remove(0);
    Ok((tag, body))
}

/// `C_WRITE` and `D_OUTPUT` share a body shape: an id, then bytes that are
/// nobody's business to parse.
pub fn encode_bytes(id: &str, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + id.len() + bytes.len());
    out.extend_from_slice(&(id.len() as u16).to_le_bytes());
    out.extend_from_slice(id.as_bytes());
    out.extend_from_slice(bytes);
    out
}

/// The inverse. `None` for a body too short to hold the id it claims — a
/// desync, and the caller drops the frame rather than guessing.
pub fn decode_bytes(body: &[u8]) -> Option<(String, &[u8])> {
    let (len, rest) = body.split_first_chunk::<2>()?;
    let len = u16::from_le_bytes(*len) as usize;
    if rest.len() < len {
        return None;
    }
    let (id, bytes) = rest.split_at(len);
    Some((String::from_utf8_lossy(id).into_owned(), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, C_WRITE, b"hello").unwrap();
        write_frame(&mut buf, D_EXIT, b"").unwrap();
        let mut r = buf.as_slice();
        assert_eq!(read_frame(&mut r).unwrap(), (C_WRITE, b"hello".to_vec()));
        assert_eq!(read_frame(&mut r).unwrap(), (D_EXIT, Vec::new()));
        assert!(read_frame(&mut r).is_err());
    }

    #[test]
    fn bytes_body_round_trips() {
        // the payload is arbitrary: NULs, newlines, invalid UTF-8, all of
        // which a terminal emits and none of which may be treated as a
        // delimiter
        let payload = b"\x00\n\xff\x1b]0;t\x07";
        let body = encode_bytes("pane-1", payload);
        let (id, bytes) = decode_bytes(&body).unwrap();
        assert_eq!(id, "pane-1");
        assert_eq!(bytes, payload);
    }

    #[test]
    fn short_body_is_rejected() {
        assert!(decode_bytes(&[]).is_none());
        // claims a 9-byte id and carries 3
        assert!(decode_bytes(&[9, 0, b'a', b'b', b'c']).is_none());
    }

    #[test]
    fn oversize_length_is_rejected() {
        let mut framed = u32::MAX.to_le_bytes().to_vec();
        framed.push(C_WRITE);
        assert!(read_frame(&mut framed.as_slice()).is_err());
    }
}
