# Vessel plugin registry template

This directory is a **template**, not runtime code. Copy its files into a
separate registry repository (for example `egg-rolls/vessel-plugins`) and serve
the result from GitHub Pages or `raw.githubusercontent.com`.

```
vessel-plugins/
├── index.json                    # copy index.sample.json here and edit
├── plugins/<id>/manifest.json    # optional full manifest for reviewers
├── plugins/<id>/README.md        # optional
├── validate.mjs
└── .github/workflows/validate.yml
```

The marketplace only reads `index.json`; it never calls the GitHub API. That is
why the index is a static file and why every asset must carry `sha256` + `size`.

## Publishing a plugin

1. **Package the plugin.** The tarball root must contain `package.json` with a
   `vessel` manifest, or one single top-level directory (npm-style `package/`)
   that contains it. Supported archive: `.tgz` / `.tar.gz` (USTAR). Absolute
   paths, `..`, symlinks and hardlinks are rejected at install time.
   Dependencies are not installed by the marketplace: either bundle them (for
   example with `bun build --target bun --outfile src/index.js`) or keep the
   plugin dependency-free.

   ```bash
   tar -czf my-plugin-0.1.0.tgz -C dist/package .
   ```

2. **Create a GitHub Release** in the plugin repository and upload the tarball
   as an asset. Release assets are the only package source in v1.

3. **Compute the checksum and size.**

   ```bash
   sha256sum my-plugin-0.1.0.tgz
   wc -c < my-plugin-0.1.0.tgz
   ```

4. **Add a version entry** to `index.json` (copy `index.sample.json` first):
   `asset.url` points at the release asset, `asset.sha256` is the 64-hex digest,
   `asset.size` is the exact byte count, `engines.vessel` covers the stable line.
   Versions must stay unique and ascending; `latest` must exist.

5. **Open a PR.** `validate.yml` runs `validate.mjs` and fails on: bad schema,
   duplicate ids/versions, non-ascending versions, missing `latest`, non-HTTPS
   assets, malformed checksum/size, an `engines.vessel` range that does not
   cover `VESSEL_STABLE`, or an asset whose downloaded bytes do not match the
   recorded sha256/size.

6. **Merge.** The index is served as-is; the marketplace picks it up after its
   10-minute cache TTL (or when the user clicks "Check now" on Updates).

## Marketplace settings

In `~/.vessel/config.yaml`:

```yaml
plugins:
  - name: marketplace
    enabled: true
    config:
      registry_url: https://<owner>.github.io/vessel-plugins/index.json
      # proxy: http://127.0.0.1:7890        # optional
      install_scope: user                   # user | project
      # project_root: /absolute/path/to/project   # needed for project scope
      allow_prerelease: false
```

- `registry_url` must be HTTPS. `http://localhost` / `127.0.0.1` is accepted
  only for local fixtures.
- The default trusted registry is
  `https://egg-rolls.github.io/vessel-plugins/index.json`. Any other URL is
  shown in red in the UI and in the install confirmation.
- `install_scope: project` writes to `<project>/.vessel/plugins/<id>`. The root
  is `settings.project_root` if set, otherwise the host-injected
  `VESSEL_PLUGIN_HOST_CWD` (Errata E4). If neither exists, the install fails
  with a clear error; it never guesses from the plugin's own cwd.
- `proxy` is passed to Bun's `fetch` `proxy` option. If your Bun build ignores
  it, set `HTTPS_PROXY` / `HTTP_PROXY` in the environment that starts Vessel.

## What the marketplace does at install time

1. reads the cached index (TTL 10 minutes);
2. downloads the asset to a temp dir, rejecting anything over 50 MiB;
3. verifies `size` and `sha256` byte-for-byte;
4. extracts with a minimal USTAR parser (rejects traversal, links, oversize);
5. verifies `package.json.vessel` id/version (and `engines.vessel` when
   `vessel_version` is configured);
6. backs up an existing `<id>` to `<id>.bak-<timestamp>`, moves the new version
   in, and rolls back on any failure;
7. writes `plugins[] {name, enabled: true}` to `~/.vessel/config.yaml`. It never
   spawns the plugin; the host watcher reloads and the first page/RPC activates
   it.

`install` and `update` are asynchronous: the RPC returns `{job_id}` immediately
and the work runs in the plugin child; the UI polls `job {job_id}` (and `jobs`
for the last 24 hours) every ~500ms for `{status, phase, bytes_done,
bytes_total, error?}`. Removal stays synchronous.

Removal deletes the directory and the config entry; update installs the newest
allowed version in place and refuses downgrades.
