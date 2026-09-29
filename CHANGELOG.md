# Changelog

What changed in each release, newest first. Upgrading? See [Upgrades](docs/self-hosting.md#upgrades): back up first,
then `git pull` (or download the new release) and `docker compose up -d --build`. Database updates run by themselves.

## 0.1.0 — first public release

- **Boards of tasks inside tasks**, as deep as you like, shown as a **Board** (lists you name), a **Timeline** and an
  **Outline** (a table you can sort, filter and rearrange). Undo and redo, filters, search, zooming into a task.
- **Sharing:** private, invited or public boards; owners, editors and viewers; share links, access codes and invites by
  email. Changes appear for everyone live.
- **Comments** with @mentions, a notification bell and a daily email summary; **attachments** on cards and in comments.
- **Email** through any SMTP server or Resend, with limits to stay within a free plan. **File storage** on the server's
  disk or in an S3-compatible bucket (Cloudflare R2, Amazon S3, MinIO); people can bring their own.
- **Self-hosting:** one Docker Compose file, an optional HTTPS add-on, backups and restores, a Platform console for
  settings, and server commands for the rest. The encryption key for saved keys is made automatically.
