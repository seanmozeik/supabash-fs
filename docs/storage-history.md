# Storage history after purge

Storage history follows durable parent links, oldest first. Purge preserves an
opaque parent link in `.supabash/ancestry/` before deleting a revision. These small
records contain no document bodies, paths, actor information, or commit metadata;
they remain after purge so retained checkpoints can be ordered across gaps.

`history({ cursor, cursorMissing: 'oldest' })` restarts at the oldest retained
revision when its cursor was purged. Normal pagination, retention counts, and
`keepAfterRevision` use the same ancestry. A retention floor must still have a
revision manifest; an ancestry record alone does not make a floor valid.

Purges performed by older versions did not preserve these links. An existing gap
cannot always be reconstructed, because timestamps may tie or clocks may move
backward. Across such a legacy gap, history and retention floors are limited to
the known head ancestry. Restore the missing parent records from backup before
purging with this version to recover the full ordering. Checkpointed snapshots
beyond a legacy gap remain readable directly by revision or checkpoint ID.

Storage still requires the documented single-writer or commit-coordinator
discipline. Ancestry is saved before deletion; a failed save leaves revisions
untouched, and a dry-run creates no ancestry records.
