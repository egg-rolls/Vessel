---
title: Plugin Registry 与 Marketplace
kind: current
triggers: [plugin, registry, marketplace, install, update, remove, checksum, github pages, release, index.json, 插件, 插件市场, 插件仓库, 安装, 更新, 卸载, 校验, 发布]
paths: [plugins/marketplace/**, docs/architecture/plugin-registry.md]
---

# Plugin Registry 与 Marketplace

> 信任模型见 [ADR-099](../adr/ADR-099-plugin-contribution-surfaces-and-trust.md)；插件清单、子进程与热重载见 [plugins](plugins.md)。

## 托管模型

- registry 是独立仓库 `github.com/<owner>/vessel-plugins`：`index.json` + 可选的 `plugins/<id>/manifest.json` / `README.md` + `.github/workflows/validate.yml`。
- 索引优先 GitHub Pages `https://<owner>.github.io/vessel-plugins/index.json`，回退 `raw.githubusercontent.com/<owner>/vessel-plugins/main/index.json`。
- 插件包是插件仓库 GitHub Releases 的资产（`.tgz` / `.zip`）；索引写死 URL + sha256 + size。
- Actions：PR 校验 schema、id/version 唯一、manifest 合法、资产可下载、sha256 匹配、`engines.vessel` 覆盖当前稳定线；合并后重排索引，可选发布 Pages。
- 运行时只读静态索引，不调用 GitHub API（避免 60/hr 限流）。
- 默认 registry `https://egg-rolls.github.io/vessel-plugins/index.json`；可配置，自定义需显式确认。

## index.json（schema v1）

```jsonc
{
  "schema": 1,
  "updated_at": "2026-11-05T00:00:00Z",
  "plugins": [{
    "id": "usage", "name": "Usage", "summary": "Usage and logs",
    "category": "observability", "tags": ["usage"],
    "repo": "https://github.com/<owner>/vessel-plugin-usage",
    "homepage": "https://...",
    "latest": "0.1.0",
    "versions": [{
      "version": "0.1.0",
      "engines": { "vessel": ">=0.33.0 <0.45.0" },
      "asset": { "url": "https://.../usage-0.1.0.tgz", "sha256": "64-hex", "size": 12345 },
      "permissions": { "fs": ["data-dir"], "net": [], "events": ["llm.*"] },
      "contributes": { "pages": ["usage"], "rpc": ["summary"] },
      "published_at": "2026-11-05T00:00:00Z"
    }]
  }]
}
```

规则：`id` 唯一；`versions[].version` semver 唯一且升序；`latest` 必须存在；`sha256` 为 64 位 hex、`size` 为正整数，下载后逐字节校验；索引只含元数据，**不内嵌** manifest 全文；安装后以包内 `package.json.vessel` 二次校验 id / version / engines。

## 发布工作流（作者）

- 插件仓库布局：`package.json`（含 `vessel` 字段）+ 入口 + `web/`；release tag `v<version>`。
- 资产命名：`<id>-<version>.tgz`（或 `.zip`），只含插件目录内容，不含 `node_modules`。
- 计算校验和：对 release 资产执行 `sha256sum <asset>`（Windows `certutil -hashfile <asset> SHA256`），并记录字节数。
- 向 registry 提 PR：在 `index.json` 的 `plugins[]` 增加 / 更新条目（id、latest、versions、asset、permissions、contributes），附 manifest / README；Actions 通过后合并。
- `engines.vessel` 必须覆盖目标 Vessel 稳定线；不满足则 CI 与安装都拒绝。

## Marketplace 插件

- 位于 `plugins/marketplace/**`，id `marketplace`，`activationEvents: ["onPage:marketplace"]`；页面 Browse / Installed / Updates；RPC `search` / `detail` / `install` / `remove` / `update` / `installed`。
- settings：`registry_url`（必填）、`proxy`、`install_scope`（`user` 默认 / `project`）、`allow_prerelease`。
- permissions：`fs: ["data-dir", "user-plugins", "project-plugins"]`、`net: ["github.com", "*.githubusercontent.com", "*.github.io"]`、events `plugin.changed`。
- 安装（子进程内）：读索引（缓存 10min）→ 选版本 → 下载临时文件（≤50 MiB）→ 校验 sha256 + size → 安全解压（拒绝绝对路径 / `..` / 符号链接 / 解压超限）→ 读包内 manifest 校验 id/version/engines → 落 `~/.vessel/plugins/<id>` 或项目 `.vessel/plugins/<id>`（已存在则备份 `<id>.bak-<ts>`，失败回滚）→ 写 `config.yaml` 的 `plugins[]`（enabled=true）。
- 不自动 spawn：由 watcher 触发 reload，首次页面 / RPC 才懒激活；能力插件下次进程启动才进 in-process，UI 明确提示。
- 更新同 id 新版本走安装流程；卸载先 deactivate/disable 再删目录；失败回滚，不留半状态。

## 信任与限制

- 索引 curated：只接受 registry PR 审核过的条目；校验和强制，无 sha256/size 拒绝安装；HTTPS only（localhost fixture 例外）。
- v1 不签名、不做供应链证明；后续可加 minisign / GitHub attestation。
- 不做市场服务端、账号、支付、评分、评论、运行时 GitHub API 搜索或自动更新（只做检查更新 + 手动 install）。
- 自定义 registry 必须显式确认并在 UI 标红；默认只信任官方 Pages 源。
- marketplace 是普通体验插件，不写进 core 或主 Web 包。
