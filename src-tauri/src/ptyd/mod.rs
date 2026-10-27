//! The pty daemon and the frames it speaks.
//!
//! `server` runs in the daemon process; `proto` is compiled into both it and
//! the app, which is the point of them sharing a binary — there is no version
//! of the wire format that only one side has.

pub mod proto;
pub mod resume;
pub mod server;
