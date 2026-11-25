---
title: SKILLS 插件 Discovery 设计——社区技能目录的搜索、预览、一键安装与信任边界
kind: draft
triggers: [skills, discovery, marketplace, 技能市场, 技能目录, 搜索, 安装, SKILL.md, registry, TOFU, plugin.skills, q-skills-discovery]
paths:
  [
    plugins/context/skills/src/tool.ts,
    plugins/context/skills/src/rpc.ts,
    plugins/context/skills/src/trust.ts,
    plugins/context/skills/src/service.ts,
    plugins/context/skills/web-src/SkillsView.tsx,
    plugins/marketplace/marketplace/src/registry.ts,
    plugins/marketplace/marketplace/src/install.ts,
    docs/dev/plans/skills-plugin-design.md,
  ]
created: 2026-11-25
---

# SKILLS 插件 Discovery 设计（design/q-skills-discovery）

> 状态：**设计稿，零代码改动**。本分支只产出文档；落地按 §12 分期另开 `feat/skills-discovery-*` 实现分支。
> 上位设计：[skills-plugin-design](skills-plugin-design.md)（P1 装载 + 信任门已落地；本文是其 §12 P3
> 「marketplace 技能包对接」的展开设计）。上位约束：[plugins](../../architecture/plugins.md)、
> [extensions](../../architecture/extensions.md)、[tools](../../architecture/tools.md)（工具判据与 token 税）。
> 先例插件：`plugins/marketplace/`（**插件**市场，CONTRACT-0.44）——registry 索引 / 校验和 / staging 安装 /
> 回滚的既有纪律，本设计大量复用其口径，但**不复用其代码路径**（技能 ≠ 插件，见 §3.2）。
> 协同：q-skills-ui（SkillsView 工具页面样式重设计，已合入 redblue-dev）——UI 衔接见 §10。

## 目录

1. [调研结论（设计的事实基础）](#1-调研结论设计的事实基础)
2. [目标与非目标](#2-目标与非目标)
3. [架构总览](#3-架构总览)
4. [Discovery 源配置](#4-discovery-源配置)
5. [索引格式与源适配器](#5-索引格式与源适配器)
6. [核心流程：搜索 → 预览 → 安装 → 更新](#6-核心流程搜索--预览--安装--更新)
7. [RPC 接口契约](#7-rpc-接口契约)
8. [权限与安全](#8-权限与安全)
9. [Agent 工具面：不变（理由）](#9-agent-工具面不变理由)
10. [UI 设计与 q-skills-ui 衔接](#10-ui-设计与-q-skills-ui-衔接)
11. [设置域与 Manifest 增补](#11-设置域与-manifest-增补)
12. [分期实施计划](#12-分期实施计划)
13. [风险与开放问题](#13-风险与开放问题)

## 1. 调研结论（设计的事实基础）

### 1.1 skills 插件现态（本 worktree 基线 redblue-dev f78516b0）

**P1 已落地**（`plugins/context/skills/`，feat/q-skills-impl 合入 + TOCTOU 修复 d7293324 +
q-skills-ui 样式重设计 6cb3673b）：

| 面 | 现态 | 对本设计的意义 |
|---|---|---|
| 三来源根 | `project` = `<cwd>/skills/`；`user` = `~/.vessel/skills/`；`library` = `<dataDir>/plugins/skills/library/`（config.ts） | **library 就是安装落地处**——discovery 不需要第四根，装进来的技能天然进入既有索引 / 工具 / UI |
| 技能形态 | flat（`<name>.md`）与 dir（`<name>/SKILL.md` + 附件清单 ≤50）双形态；frontmatter 只认 `name/description/version/tags` 四键子集，未知键忽略标 `partial`（scanner.ts / frontmatter.ts） | 与社区 Agent Skills 规范**天然兼容**（§1.3）：name/description 是规范必填键的子集；license/allowed-tools 等落 `partial` 忽略，不报错 |
| 信任门 | trust.ts 单一口径：`trustStateOf`（unknown/trusted/stale/revoked）+ `loadGateDecision`（trusted→allow；unknown/stale→ask，`trust_default=deny` 时 deny；revoked→deny）；TOFU 钉锁在**用户批准后的 handler 内**；TOCTOU 闸按 tool_call_id 比对判定期哈希 | **安装 ≠ 信任**有现成落点：装进 library 不写 trust.json → 首次 load 必然 unknown → ask。门一行不用改 |
| origin 预留 | `TrustRecord.origin: 'local' \| 'import' \| 'marketplace'`（types.ts:60）；`originOfSource` 目前 library→'import'；tool.ts 钉锁时 `previous?.origin ?? originOfSource(source)`，注释明示「marketplace 不自动提升」 | origin='marketplace' 已预留但**无写入路径**——本设计补 provenance 侧车（§6.3），钉锁时派生，不改门 |
| 工具 | `skills` 单工具三动作 list/search/load；list/search 恒 allow（只读元数据），load 过门 + 记 loads（tool.ts） | 工具面**零改动**（§9）：discovery 是人类面能力，走 RPC + UI |
| RPC | `plugin.skills.{list,get,search,loads,rescan,trust_set}` 六方法（rpc.ts）；`get` 是人类面预览：不写 loads、不做信任门 | discovery RPC 沿用同一契约纪律（DTO additive、业务错误在 result 内、read/write 权限列）；`get` 的「看 ≠ 加载」边界直接延伸到远程预览 |
| 隔离 | library 根经装配层追加进 basic-tools `deny_paths`：模型 read/edit 收集库被拒，内容只能经 `skills load` 信任门进语言空间 | 装进来的社区技能**自动继承隔离**，无需新缝 |
| UI | SkillsView master-detail + TableToolbar 单行紧凑工具栏 + DataTable 透黑底细线卡片（q-skills-ui 重设计已合入）；embed + iframe 双产线 | discovery tab 在既有组件体系内加（§10），不新造页面骨架 |
| 存储纪律 | index.json 整文件覆盖（派生缓存）；trust.json / loads 临时文件 + rename 原子写；进程内单写队列串行化（store.ts / service.ts） | discovery 缓存与 provenance 沿用同款纪律（§5.4 / §6.3） |
| 上限 | 单文件 1 MiB（oversize 可 list 不可 load）、条目 5000、load/get 64 KiB、页 50、深度 8（types.ts 常量） | 安装校验直接复用 scanner 对 staging 跑一遍——上限口径零新增 |

**P2 现态澄清（诚实纠偏）**：任务书称「P2（导入/注入）已落地」，但基线代码里 `rpc.ts` 只有上述六方法，
**`import` RPC 与「注入会话」尚未实现**——它们停留在上位设计 §7（import 行标注 P2）与 §12 P2 清单。
library 根、deny_paths 隔离、origin='import' 派生等 P2 的**地基**已随 P1 落地。对本设计的影响：

- discovery 安装与 P2 import 共用「外来内容 → library 落地」管线（containment / 大小 / 冲突校验 +
  原子 rename + rescanRoot）。本设计把该管线定义为共享 helper（§6.3），**谁先实现谁落**，
  另一方复用；不阻塞、不重复。
- 若 P2 import 先行，discovery 安装 = 「下载 + 校验」+ import 管线；若 discovery 先行，
  P2 import = 「本地路径读取」+ 同一管线。分期协调见 §12。

### 1.2 先例：marketplace 插件（插件市场）的既有纪律

`plugins/marketplace/marketplace/`（CONTRACT-0.44）已解决「远程目录 → 搜索 → 安装 → 更新」的
工程问题，其口径是本设计的直接参照（读源码核实）：

| 纪律 | 落点 | 本设计如何复用 |
|---|---|---|
| registry 索引 schema 1：`{schema, updated_at, plugins[]}`，每版本 `asset {url, sha256, size}`；**sha256 必填，无签名条目拒收**（`unsigned entries are refused`） | registry.ts parseAsset | skills registry 索引同构（§5.1），asset 校验和必填同款 |
| URL 安全：https 必须；http 仅 loopback（localhost/127.0.0.1/::1）fixture 例外；**redirect 落点重校验**（`assertSecureUrl(response.url)`） | registry.ts assertSecureUrl / install.ts downloadAsset | 逐字同款（§8.3） |
| 索引缓存：TTL 10 min、上限 5 MiB、损坏/失败回落旧快照标 `stale` | registry.ts REGISTRY_CACHE_TTL_MS / MAX_INDEX_BYTES / RegistrySnapshot | discovery 缓存同款（§5.4） |
| 安装管线：resolving → downloading → verifying → extracting → installing → configuring；mkdtemp staging → 校验 → 旧目录 rename 备份 → moveDir（EXDEV 回落 copy+delete）→ 失败回滚备份 | install.ts installLocked | 技能安装同构但更简（无 config 写入、无 engines 检查；§6.3） |
| 下载硬边界：content-length 预检 + 流式累计上限、120s startDeadline（bun AbortSignal.timeout 坑的现态解法）、tar 解压限额（ArchiveLimits） | install.ts downloadAsset / tar.ts | 同款限额口径，数值按技能体量收紧（§8.4） |
| tar 安全：parseTarEntries 限额 + stripCommonRoot + extractEntries containment | tar.ts | dir 形态技能包解压复用同一套解析纪律（代码共享方式见 §5.3 开放问题） |
| 更新：读已装版本 → 比对 registry latest → 显式 update 走 installLocked 原位替换；**不自动更新** | install.ts updatePlugin | 技能更新检查同口径：provenance 比对 + 显式动作 + 信任门照常 stale 重确认（§6.4） |
| registry_url 可配置：configureRegistry 写 config.yaml `plugins[].config`；未配置时 UI 仍加载并显示「去配置」（activation 不因缺 registry 失败） | install.ts configureRegistry / settings.ts | discovery 源配置同款体验（§4） |
| net 权限声明式：`net: ["github.com", "*.githubusercontent.com", "*.github.io"]` | marketplace package.json | skills manifest additive 申请同款主机集（§11.2） |
| 异步安装走 background job（进度轮询） | jobs.ts | 技能包 ≤10 MiB，P3 同步 RPC + 120s deadline 足够；进度面留开放问题（§13） |

**关键差异（为什么不是直接装插件）**：marketplace 装的是**代码**（in-process/child 插件，有
manifest/engines/permissions 审查与 config 写入）；discovery 装的是**数据**（markdown 技能文件，
永不执行、无 manifest、无 config 写入）。技能安装的审查面 = 内容校验和 + 扫描器上限 + TOFU 信任门，
比插件安装**更轻**，但信任门**更严**（插件装上即激活；技能装上仍是 unknown，首次 load 要人批准）。

### 1.3 社区 skills 生态（2026-11 调研）

**格式标准——Agent Skills 开放规范（agentskills.io，anthropics/skills 仓库 `spec/`）**：

- 技能 = 目录，至少含 `SKILL.md`；可选 `scripts/`、`references/`、`assets/` 附属目录。
- frontmatter 必填 `name`（≤64 字符，小写字母/数字/连字符，**须与父目录名一致**）、
  `description`（≤1024 字符）；可选 `license`、`compatibility`（≤500 字符）、
  `metadata`（自定义键值映射，author/version 常放这里）、`allowed-tools`（实验性，空格分隔预批准工具列表）。
- 渐进披露三层：元数据（~100 token，启动即载）→ SKILL.md 正文（建议 <5000 token，激活才载）→
  附属文件（按需读）。建议正文 ≤500 行。
- **与 vessel 四键子集的关系**：name/description 完全兼容；vessel 的 version/tags 在规范里走
  `metadata` 或未知键 → 现态解析器标 `partial` 忽略，**不需要改解析器**。`allowed-tools` 对 vessel
  无意义（工具权限走 checkPermission，技能文件不自证权限）——忽略即正确语义。
  规范 name≤64 / description≤1024 vs vessel description 截断 200：索引展示截断，load 返回原文，不冲突。

**目录源（按可依赖性排序）**：

| 源 | 形态 | 事实 | 可依赖性 |
|---|---|---|---|
| `anthropics/skills`（GitHub） | git 仓库：`skills/<name>/SKILL.md` + `spec/` + `template/` + `.claude-plugin/marketplace.json` | Anthropic 官方示例库（document-skills：docx/pdf/pptx/xlsx 等，Apache-2.0）；同时注册为 Claude Code plugin marketplace | 高：结构稳定、https raw / REST API / codeload tarball 三条下载通道 |
| `vercel-labs/agent-skills` 等社区仓库 | 同上惯例（`skills/<name>/SKILL.md` 或根级 `<name>/SKILL.md`） | skills.sh 生态的安装源；`npx skills add <owner/repo>` 支持 75+ agent 宿主 | 高：GitHub 通道同上 |
| **skills.sh**（vercel-labs/skills CLI 的目录站） | 排行榜 + `npx skills find [query]` 搜索 | CLI 有 `skills-lock.json` v2：**computedHash**（技能目录全文件 SHA-256，CRLF→LF 归一、路径排序）+ **git commit 钉住**（restore 按 commit 取，不追 ref HEAD）；`skills check/update` 显式更新 | 中：CLI/lock 格式公开且文档化，但**站点搜索 API 无公开契约**——不依赖其私有 API（§5.2 决策） |
| 聚合站（skillsmp 等，宣称收录 33k+ GitHub skills） | 网站搜索 / 分类 | 第三方聚合，API 契约不明 | 低：P3 不做适配器；用户可把聚合站当浏览器入口，复制 repo 地址走 github 源 |
| awesome-list（awesome-claude-skills 等） | markdown 链接清单 | 人工策展，无机器可读索引 | 低：不做解析器；策展价值由 vessel-skills curated registry 吸收（§4.3） |
| Claude Code plugin marketplace（`.claude-plugin/marketplace.json`） | 插件级目录（一个 plugin 打包多个 skills） | anthropics/skills 即用此格式分发 | 中：格式公开，但语义是**插件**不是技能；P3 不解析（避免引入插件安装面），github 适配器直接扫 SKILL.md 目录 |

**对本设计的三个生态结论**：

1. **GitHub 仓库是最大公约数**：官方库、社区库、聚合站收录对象全是 GitHub 仓库。github 源适配器
   （REST tree 枚举 + commit 钉住 + tarball/raw 下载）覆盖绝大多数真实需求，且通道稳定、无需第三方 API key。
2. **curated registry 是 vessel 自己的策展入口**：复用 vessel-plugins 的 GitHub Pages 静态索引模式
   （`egg-rolls.github.io/vessel-plugins/index.json` 先例），发布 `vessel-skills/index.json`——
   种子内容 = 本仓 `skills/` 既有技能 + 人工审核的社区精选。静态 JSON、无服务端、可审计。
3. **完整性纪律向 skills-lock v2 看齐**：commit 钉住（可复现安装）+ 内容哈希（掉包检测）。
   vessel 已有单文件 sha256 TOFU 锁；discovery 补「安装时来源 provenance」（§6.3），
   目录级 computedHash 是否引入留开放问题（§13，倾向不引入：vessel 信任门钉的是 SKILL.md 单文件哈希，
   附件走 read 边界，目录哈希会发明第二套信任口径）。

## 2. 目标与非目标

### 2.1 目标

用户需求原话：「技能插件能不能搜索到一些常用的 skills 目录，存放以便使用」。拆成四个可验收能力：

1. **搜得到**：SkillsView 内搜索常用 / 社区 skills 目录（curated registry + GitHub 仓库源），
   关键词 / 标签过滤，结果带名称 / 描述 / 来源 / 信任提示。
2. **看得见**：安装前预览 SKILL.md 原文与元数据（人类面，同 `get` 边界：不进语言空间、不记 loads）。
3. **装得下**：一键安装到本地 library 根（下载 → 校验和 / commit 钉住 → staging 扫描校验 →
   原子落地 → 索引刷新），装完即出现在既有 list/search/UI 里。
4. **信得过（门照常）**：**安装 ≠ 信任**。装进 library 的技能 trust 态仍是 unknown，首次
   `skills load` 照常 ask（`trust_default=deny` 照常 deny）；TOFU 钉锁、TOCTOU 闸、stale 重确认、
   revoke、deny_paths 隔离**全部原样生效，零改动**。更新 = 显式动作 + 哈希变化 → stale 重确认。

### 2.2 非目标（任何期都不做，除非另开 ADR）

- **不改 `skills` 工具面**：不加 discover/install 模型动作（§9 论证）；安装是人的信任决策，不是模型动作。
- **不自动信任 / 不自动更新**：curated 来源也不自动提升信任（上位设计 §9.2 明示）；
  更新检查只报告，落地永远显式动作。
- **不执行技能内容**：process:false 不变；scripts/ 附件只列清单，模型自己跑脚本走 bash 权限判定（T7 现态）。
- **不解析 Claude Code plugin marketplace / 不装插件**：技能是数据不是代码；插件安装归 marketplace 插件。
- **不依赖第三方私有 API**（skills.sh 搜索接口、聚合站接口）：无公开契约 = 不可依赖；GitHub 公开通道除外。
- **不做语义检索 / embedding**：上位设计 P3 另项，opt-in 成本税，本期子串检索够用。
- **不做跨节点同步 / 团队共享协议**：上位设计非目标延续；共享走仓库提交或 curated registry。
- **不新增 core 接口 / 宿主事件 / 第二注册表**：discovery 是 skills 插件内部模块 + additive RPC。
- **不承诺 OS 沙箱 / 内容审查**：预览「沙箱」= 纯文本渲染 + 人类面边界（§8.5），不是隔离执行环境。

## 3. 架构总览

### 3.1 形态：skills 插件内部模块，不是新插件

discovery 落在 `plugins/context/skills/src/discovery/`，与 scanner / trust / store 并列：

```text
plugins/context/skills/
├── src/
│   ├── discovery/            # ★ 新增（本设计）
│   │   ├── sources.ts        # 源配置解析 + 校验（config.ts 同款纪律）
│   │   ├── registry.ts       # registry 适配器：索引 fetch / 解析 / 校验
│   │   ├── github.ts         # github 适配器：commit 解析 / tree 枚举 / raw 下载
│   │   ├── local.ts          # local 适配器：本地目录浏览（P3b，复用 scanner）
│   │   ├── cache.ts          # 每源快照缓存（TTL / stale 回落 / ETag）
│   │   ├── install.ts        # 下载 → 校验 → staging → 落地管线
│   │   ├── landing.ts        # ★ 共享落地 helper（与 P2 import 共用，§6.3）
│   │   └── provenance.ts     # 安装来源侧车（provenance.json，原子写）
│   ├── rpc.ts                # dispatch 增 discovery_* 分支（additive）
│   ├── tool.ts               # 零改动（§9）；钉锁 origin 派生一处 additive（§6.3）
│   ├── trust.ts / service.ts / scanner.ts / store.ts   # 零改动
│   └── config.ts             # 增 discovery 键解析（additive）
└── web-src/
    ├── SkillsView.tsx        # 增 Library / Discover 切换（§10）
    └── DiscoverView.tsx      # ★ 新增：搜索 / 结果表 / 预览 / 安装
```

理由（按承重顺序）：

1. **library 根、信任门、隔离、索引、UI 全在 skills 插件里**。discovery 的产出物（library 里的
   技能文件）只有经 skills 的 scanner/trust 才有意义；拆成独立插件 = 跨插件写别人的 dataDir +
   第二套信任口径，违反「不新增第二注册表」纪律。
2. **marketplace 插件装代码、skills 装数据**，审查面与落地处完全不同（§1.2）；合并进 marketplace
   会把「技能信任门」与「插件激活」两套语义搅在一起。
3. in-process 形态延续上位设计 §3：零新宿主缝，install 期解析配置，RPC 经既有
   `registerInProcessPlugin` 登记，UI 经既有 embed/iframe 双产线。

### 3.2 数据流（一张图）

```text
 源（https）                    skills 插件宿主侧                          既有面（零改动）
┌──────────────────┐   ┌──────────────────────────────────────┐   ┌─────────────────────────┐
│ vessel-skills     │   │ discovery/registry|github|local       │   │ scanner → index.json    │
│ registry index.json│──▶│  fetch → 校验 → cache（TTL 10min）    │   │ trust.ts 信任门 / TOCTOU │
│ GitHub repo@commit│   │        │                              │   │ skills 工具 list/search/ │
│ 本地目录（P3b）    │   │        ▼ search（子串，searchRank 口径）│   │   load（门照常）         │
└──────────────────┘   │        ▼ preview（SKILL.md 原文，人类面）│   │ SkillsView Library tab  │
                       │        ▼ install（显式动作）            │   │ deny_paths 隔离          │
                       │  下载 → sha256/commit 校验 → staging    │   └─────────────────────────┘
                       │  → scanner 校验 → landing.ts 原子落地 ──┼──▶ library/<name>/SKILL.md
                       │  → provenance.json（来源侧车）          │      （trust 态 = unknown，
                       │  → rescanRoot('library')               │       首次 load 才 TOFU）
                       └──────────────────────────────────────┘
```

三条边界重申（上位设计 §9.5 延伸）：

- **预览是人类面**：远程 SKILL.md 原文只进 UI（纯文本渲染），不进任何 run 的语言空间、不记 loads、
  不触发 TOFU——与 `get` RPC 同边界。
- **安装是宿主侧数据搬运**：写 library 文件 + provenance，**不写 trust.json**。
- **加载才过门**：模型 `skills load` 走既有 checkPermission → ask → handler 钉锁，一行不改。

### 3.3 存储布局增补（插件私有目录，fs: ["data-dir"] 既有权限内）

```text
<dataDir>/plugins/skills/
├── library/                  # 既有：安装落地处（dir 形态 <name>/SKILL.md；flat 形态 <name>.md）
├── discovery/                # ★ 新增
│   ├── <sourceId>.json       # 每源索引快照缓存（派生缓存，可整文件重建/删除）
│   └── provenance.json       # 安装来源记录（宿主侧写，临时文件 + rename 原子写）
├── index.json / trust.json / loads/ / logs/    # 既有，零改动
```

写纪律延续：缓存整文件覆盖（损坏 → 视为无缓存，重新 fetch）；provenance.json 原子写 +
进程内单写队列（与 trust.json 同款）；staging 临时目录 `mkdtemp(stateDir/tmp-)`，finally 清理。

## 4. Discovery 源配置

### 4.1 配置形状（config.yaml `plugins[].config.discovery`，additive）

```yaml
plugins:
  - name: skills
    config:
      # …既有 enabled / sources / watch / trust_default / max_load_bytes 不动…
      discovery:
        enabled: true                # 缺省 true；false = 不注册 discovery RPC / UI tab
        sources:
          - id: vessel-skills        # 源唯一 id（^[a-z0-9][a-z0-9-]{1,63}$，marketplace 同款）
            kind: registry           # registry | github | local
            url: https://egg-rolls.github.io/vessel-skills/index.json
            tier: curated            # curated | community | local（展示分级，§8.2）
          - id: anthropics           # P3b 起可用的预置 github 源（缺省不启用，UI 一键添加）
            kind: github
            repo: anthropics/skills  # owner/repo
            ref: main                # 分支/tag；刷新时解析为 commit 钉住
            path: skills             # 仓库内技能根（缺省自动探测 skills/ 与根级）
            tier: community
          - id: my-team              # P3b：本地目录源（浏览 + 导入，复用 import 管线）
            kind: local
            path: ~/team-skills
            tier: local
        cache_ttl_ms: 600000         # 缺省 10 min（marketplace REGISTRY_CACHE_TTL_MS 同款）
        max_download_bytes: 10485760 # 缺省 10 MiB（技能是 markdown，比插件包收紧）
```

解析纪律与 config.ts 逐字同款：install 期解析一次（in-process 生效语义 = 重启）；camelCase /
snake_case 双收；未知键忽略；非法值回落缺省 + warning，不半应用；`discovery` 非 object →
整体回落缺省 + warning。新增上限常量：`MAX_DISCOVERY_SOURCES = 8`（超出截断告警）。

### 4.2 缺省源与「未配置」体验

- **缺省 sources = [vessel-skills registry]**（curated）。该索引随 P3a 发布（§4.3）；发布前 /
  fetch 失败时**不阻塞 activation**——marketplace 先例：registry_url 缺失 UI 照常加载并显示
  「去配置」。discovery tab 显示源状态（ok / stale / unavailable + 原因），Library tab 完全不受影响。
- `discovery.enabled=false` 或 sources 为空：discovery RPC 返回业务错误
  `discovery_disabled` / `no_sources`（result 内结构化错误，不发明信封 code），UI tab 隐藏或显示引导。
- **github / local 源缺省不预置启用**：用户经 UI「添加源」或 config.yaml 显式加入（社区内容
  opt-in，与 trust_default 的 fail-closed 哲学一致）。UI 提供预置模板（anthropics/skills 等
  知名仓库）降低输入成本，但添加动作 = 用户显式选择。

### 4.3 curated registry：vessel-skills（P3a 交付物，非代码）

复用 vessel-plugins 的 GitHub Pages 静态索引模式（`egg-rolls.github.io/vessel-plugins/index.json`
先例，registry-template/ 有 validate.mjs + CI 校验同款）：

- 仓库 `egg-rolls/vessel-skills`：`index.json`（§5.1 schema）+ 技能包资产（release tgz 或
  Pages 静态文件）+ validate CI（schema / sha256 / URL 校验，marketplace registry-template 同款）。
- **种子内容**：本仓 `skills/` 既有技能（code-writing 等）打包 + 人工审核的社区精选
  （anthropics/skills 的 document-skills 等，注明上游 repo@commit 与 license）。
- 策展纪律：每条 entry 必须带 `source`（上游 repo + commit + path）与 license；收录 = 人工
  看过内容，但**策展 ≠ 信任**——tier=curated 只影响展示与排序，不影响信任门（§8.2）。
- 该仓库与索引发布是独立交付物（文档 + 静态资产），不占 skills 插件代码分支。

## 5. 索引格式与源适配器

### 5.1 registry 索引 schema（vessel-skills index.json，schema 1）

与 marketplace registry 同构（§1.2），把 `plugins[]` 换成 `skills[]`、asset 增 `kind`：

```jsonc
{
  "schema": 1,
  "updated_at": "2026-11-25T00:00:00Z",
  "skills": [
    {
      "id": "code-writing",                  // ^[a-z0-9][a-z0-9-]{1,63}$（marketplace PLUGIN_ID_RE 同款）
      "name": "code-writing",                // 展示名（缺省 = id）
      "summary": "本仓代码风格与提交纪律",     // ≤200 字符（索引展示截断口径）
      "description": "…",                    // 长描述（预览页用）
      "tags": ["code", "style"],             // ≤16 个，每个 ≤32 字符（types.ts 同款上限）
      "license": "MIT",
      "repo": "https://github.com/egg-rolls/vessel-skills",
      "latest": "1.2.0",
      "versions": [
        {
          "version": "1.2.0",
          "asset": {
            "kind": "dir",                   // dir = tgz 技能目录；flat = 单 .md 文件
            "url": "https://…/code-writing-1.2.0.tgz",
            "sha256": "<64 hex>",            // 必填；无校验和条目拒收（marketplace 逐字同款）
            "size": 12345                    // 正整数，≤ max_download_bytes
          },
          "source": {                        // 上游 provenance（策展可审计）
            "kind": "github",
            "repo": "anthropics/skills",
            "commit": "<40 hex>",            // 钉住的上游 commit
            "path": "skills/docx"
          },
          "preview": {                       // 可选；curated 索引必须提供（§6.2 轻量预览通道）
            "url": "https://…/code-writing/SKILL.md",   // raw SKILL.md，https 同款校验
            "sha256": "<64 hex>"
          },
          "published_at": "2026-11-25T00:00:00Z"
        }
      ]
    }
  ]
}
```

校验纪律（registry.ts 同款，逐条对齐 marketplace parseAsset / optionalHttpUrl）：

- `schema !== 1` → `registry_invalid`；索引字节上限 5 MiB（MAX_INDEX_BYTES 同款）；
  条目上限 `MAX_REMOTE_ENTRIES = 2000`/源（超出截断 + warning，防 DoS）。
- asset.url / repo / homepage 仅 http(s)；**下载 URL https 必须，http 仅 loopback fixture**；
  sha256 64 hex 必填；size 正安全整数。任何一条非法 → 整条目拒收 + warning（不半应用）。
- 版本选择：缺省 latest；`versions[]` 语义与 marketplace 一致（显式版本可装旧版）。
  技能无 engines / prerelease 概念——不引入 semver 依赖，版本比对用 marketplace semver.ts
  同款全 semver 校验（共享方式同 §5.3 tar 开放问题）。

### 5.2 github 适配器（P3b）：commit 钉住 + 逐文件 raw 下载

**不依赖 skills.sh 私有 API**（§1.3 结论）；只用 GitHub 公开通道，无 token（匿名限流
60 req/h/IP → 缓存 + 条件请求兜底，§5.4）：

1. **解析 commit**：`GET api.github.com/repos/{owner}/{repo}/commits/{ref}` → `sha`。
   快照缓存记录该 commit；TTL 内搜索 / 预览 / 安装全部钉住它（skills-lock v2 同款
   「restore 按 commit 不追 HEAD」纪律）。刷新 = 显式动作或 TTL 过期。
2. **枚举技能**：`GET api.github.com/repos/{owner}/{repo}/git/trees/{commit}?recursive=1`
   → 找 `SKILL.md` 条目（配置 `path` 根下，或自动探测 `skills/` 与根级）。
   - `truncated: true`（超大仓库）→ 只取已返回部分 + warning。
   - mode `120000`（symlink）条目**跳过**（scanner fail-closed 同款）；路径词法校验
     （无 `..`、无绝对路径、深度 ≤ MAX_SCAN_DEPTH）。
   - 每个 SKILL.md 所在目录 = 一个技能；dir 名即候选 name（规范：name 须与目录一致）。
3. **元数据补全（懒加载 + 限额）**：tree 只有路径，没有 description。对前
   `MAX_GITHUB_METADATA_FETCHES = 200` 个条目经 `raw.githubusercontent.com/{repo}/{commit}/{path}/SKILL.md`
   取原文 → frontmatter 子集解析（复用 frontmatter.ts，纯数据）→ name/description/tags。
   超出限额的条目只有 name 可搜 + warning；预览时按需单取。并发上限 4，单文件 ≤1 MiB。
4. **下载（安装时）**：**逐文件 raw 下载，不拉整仓 tarball**——tree 已给出技能目录下全部
   文件路径（≤ MAX_AUX_FILES + 1 个 SKILL.md），按 commit 逐个取 raw，每个 ≤1 MiB、
   合计 ≤ max_download_bytes。好处：无 tar 依赖、无整仓体量税、天然逐文件 containment。
   完整性 = commit 钉住 + TLS（GitHub 无逐文件上游哈希）；落地后 sha256 由本地计算记入
   provenance，TOFU 门照常兜底。
5. **flat 单文件技能**：registry asset.kind=flat 直接下载 .md（无 tar）；github 源里
   根级裸 .md（无 SKILL.md）不识别为技能——规范以 SKILL.md 为锚，避免把 README 当技能。

### 5.3 local 适配器（P3b）与共享代码决策

- **local 源** = 本地目录浏览：复用 `scanSkillRoot`（containment / symlink 跳过 / 上限全套）
  产出只读索引；「安装」= 复制进 library，走 §6.3 共享 landing 管线——**这正是 P2 import 的
  超集**（import 是单路径动作，local 源是可搜索的目录面）。P2 import 落地后 local 源薄封装即可。
- **tar / gunzip / semver 共享**（registry dir 资产需要）：marketplace 的 tar.ts / semver.ts
  自包含、无插件私有依赖。两个选项：
  - **推荐**：抽成小 workspace 包 `@vessel-agent/archive`（additive 新包），marketplace 迁移
    是独立协调 commit（不属本设计分支）；skills 依赖新包。
  - 回落：vendor 拷贝进 `skills/src/discovery/tar.ts`（注明出处与同步责任）。
  裁决留实现评审（§13 开放问题 2）；**禁止**跨插件相对路径 import 私有源码。

### 5.4 缓存与刷新

- 每源快照 `discovery/<sourceId>.json`：`{sourceId, fetchedAt, commit?, etag?, entries[], warnings[]}`。
  整文件覆盖；损坏 → 视为无缓存重新 fetch（派生缓存纪律）。
- TTL 10 min（可配 `cache_ttl_ms`）；TTL 内命中缓存零网络。**fetch 失败回落旧快照标 `stale`**
  （marketplace RegistrySnapshot.stale 同款），UI 显示「快照时间 + 刷新按钮」。
- github 源条件请求：缓存 etag（tree/commits 响应 ETag），刷新带 `If-None-Match` → 304 零成本；
  403 限流 → 回落旧快照 + warning（不重试风暴）。
- `discovery_refresh` RPC（write）= 显式绕过 TTL 重取；UI 刷新按钮 / 页面聚焦不自动绕过
  （聚焦重拉只读缓存，与上位设计「不新增宿主事件」纪律一致）。

### 5.5 远程条目 DTO（搜索结果 / 预览共用）

```ts
interface RemoteSkillEntry {
  sourceId: string;                 // 配置里的源 id
  kind: 'registry' | 'github' | 'local';
  tier: 'curated' | 'community' | 'local';
  id: string;                       // 源内唯一：registry = entry.id；github = 目录相对路径
  name: string;
  description: string;              // 展示截断 200 字符（本地索引同口径）
  tags: string[];
  version?: string;
  license?: string;
  repo?: string;                    // 上游仓库（可点链接，仅 http(s)）
  commit?: string;                  // github 源 / registry source 钉住的 commit
  assetKind: 'flat' | 'dir';
  bytes?: number;
  sha256?: string;                  // registry asset 校验和（github 源无上游哈希）
  /** 已安装态（provenance + 本地索引 join 派生；UI「已安装 / 可更新」徽标） */
  installed?: { localId: string; trust: TrustState; version?: string; commit?: string };
  warnings?: string[];
}
```

搜索排序复用 `searchRank` 单一口径（name > tag > description > id，tool.ts 导出函数直接
import——同插件内共享，无跨插件问题）；多源结果合并后按 rank → tier（curated 前）→ id 排序；
分页 ≤50（MAX_PAGE_LIMIT 同款）。**搜索是纯缓存内子串匹配，零网络**（网络只发生在刷新）。

## 6. 核心流程：搜索 → 预览 → 安装 → 更新

### 6.1 搜索（discovery_search）

1. 读源快照缓存；无缓存或 TTL 过期 → 同步 fetch（索引 fetch 30s deadline；失败回落旧快照
   标 stale，无旧快照 → 业务错误 `registry_fetch_failed`，UI 显示原因 + 重试）。
2. 缓存内子串匹配（searchRank 口径：name > tag > description > id），source / tag 过滤，
   多源合并排序（rank → tier curated 前 → id），分页 ≤50。**匹配阶段零网络。**
3. join provenance + 本地索引派生 `installed` 字段（已安装 / trust 态 / 版本差），
   UI 据此渲染「安装 / 已安装 / 可更新」三态按钮。

### 6.2 预览（discovery_preview）——人类面，看 ≠ 加载

- 取 SKILL.md 原文：registry 源用索引里的 `preview: {url, sha256}` 字段（curated 索引
  **必须**提供，指向 raw SKILL.md；§5.1 schema 增补该可选键）；github 源按钉住 commit 取
  raw；local 源经 boundary 读文件。无 preview 通道 → 业务错误 `preview_unavailable`，
  UI 降级为纯元数据卡片（不下载整包来预览——预览必须轻）。
- 返回 `{entry: RemoteSkillEntry, content, auxFiles: string[], truncated, warnings}`：
  content 截断 64 KiB（capContent 复用）；auxFiles 只列清单（github tree / tgz 条目 /
  目录扫描），**不取附件内容**。
- 边界逐字对齐 `get` RPC：不写 loads、不做信任门、不触发 TOFU、不进任何 run 的语言空间。
  UI 纯文本渲染（§8.5）。frontmatter 只当数据解析（子集解析器复用，无 eval）。

### 6.3 安装（discovery_install）——七步管线，信任门零改动

```text
① resolve   缓存快照里定位条目（registry: version；github: 钉住 commit）
② download  下载到 mkdtemp staging：
            registry flat → 单 .md；registry dir → tgz（gunzip+tar 限额+stripCommonRoot）
            github → 逐文件 raw@commit（≤50 附件+SKILL.md，每个 ≤1 MiB，合计 ≤10 MiB）
            local → boundary 校验后复制
③ verify    registry: sha256 比对 asset.sha256（不符 → checksum_mismatch，拒装）
            github: commit 钉住即完整性锚（无上游哈希）；逐文件计算 sha256 记入 provenance
④ validate  对 staging 跑 scanSkillRoot（scanner 全套：containment / symlink 跳过 /
            1 MiB 单文件 / 深度 8 / 附件 50）；dir 形态要求 frontmatter.name == 目录名
            （规范约束；不符 → skill_name_mismatch 拒装，防 id 混淆）
⑤ conflict  目标 library/<name>/（或 <name>.md）已存在：
            overwrite 缺省 false → already_installed（带 localId，UI 引导去 Library）
            overwrite=true（UI 二次确认）→ 旧目录 rename 备份 → 落新 → 删备份；
            **trust.json 记录原样保留**：哈希变了 → stale → 下次 load 重新 ask；
            revoked 记录保留 → 仍然 deny。绝不自动重钉 / 绝不删信任记录
⑥ land     moveDir staging → library 目标（EXDEV 回落 copy+delete；失败回滚备份，
            marketplace installLocked 同款）；写 provenance.json（原子写，单写队列）
⑦ index    rescanRoot('library') → 新条目进索引（trust=unknown）→ 返回 {entry, provenance, warnings}
```

**provenance.json 形状**（安装来源侧车，宿主侧唯一写口）：

```ts
interface ProvenanceRecord {
  localId: string;               // 'library/<name>/SKILL' 等（与索引 id 同口径）
  sourceId: string;
  kind: 'registry' | 'github' | 'local';
  origin: 'marketplace' | 'import';   // registry/github → marketplace；local → import
  repo?: string;
  commit?: string;               // 安装时钉住的 commit（更新检查的比对锚）
  version?: string;
  assetSha256?: string;          // registry asset 校验和
  files: Array<{ path: string; sha256: string }>;   // 落地文件清单 + 本地哈希（审计）
  installedAt: string;
  updatedAt: string;
}
```

**origin 派生（唯一一处既有文件 additive 改动）**：tool.ts / rpc.ts 钉锁路径现态是
`previous?.origin ?? originOfSource(source)`；增补为
`previous?.origin ?? provenanceOrigin(localId) ?? originOfSource(source)`——
provenance 存在则取 'marketplace'，否则回落现态。**门判定、TOCTOU、stale 逻辑零改动**；
已有记录保留 origin 的现态语义（marketplace 不自动提升）逐字保留。

**landing.ts 共享 helper**：④⑤⑥⑦ 抽成与来源无关的落地管线（入参 = staging 目录 +
provenance 草稿）。P2 import（本地路径 → library）与 discovery install 共用；谁先实现谁落，
另一方薄封装（§1.1 纠偏、§12 协调）。

**安装不写 trust.json**——这是「安装 ≠ 信任」的机制保证，不是约定俗成：装完的技能
trust=unknown，模型首次 load 照常 ask；`trust_default=deny` 环境照常 deny。
用户可以在 UI 里先预览再手动 trust_set(trust)（既有多写口之一），那也是人的显式动作。

### 6.4 更新检查与更新（discovery_updates / discovery_update）

- **检查（只报告）**：遍历 provenance → registry 源比对 latest version（semver）；
  github 源解析 ref 当前 commit（条件请求，限流回落缓存）比对钉住 commit；local 源比对
  文件哈希。返回 `{updates: [{localId, sourceId, from, to}], checkedAt, warnings}`。
  UI 在 Library 行 / Discover 结果上显示「可更新」徽标。**不自动下载、不自动落地。**
- **更新（显式动作）**：`discovery_update {local_id}` = 对同一来源条目重跑 §6.3 管线
  （新版本 / 新 commit，overwrite 语义内置但 UI 仍二次确认）。内容哈希变化 → 既有信任锁
  派生 stale → 下次 load 重新 ask（T2 对策原样生效）。provenance 更新 commit/version/updatedAt。
- 批量「全部更新」P3b 再议：一次显式动作覆盖 N 个技能可接受（每个技能的信任仍各自重确认），
  但 P3a 不做——先把单条路径走稳。
- **删除 / 孤儿清理**：技能文件被用户删除后，rescan diff 发现 localId 消失 → 顺手剪掉
  provenance 孤儿记录（派生数据随真相源）；trust.json 孤儿记录保留供审计（现态语义不动）。

## 7. RPC 接口契约

canonical 名 `plugin.skills.discovery_<name>`（宿主补前缀，与既有六方法同登记面）；
manifest `contributes.rpc` additive 声明（§11.2）。契约纪律逐字延续上位设计 §7：
DTO additive、业务错误在 result 内 `{error: {code, message}}`、不发明信封 code、
**不新增宿主事件**（UI 刷新 = mutation 后重拉 + 手动刷新 + 聚焦重拉缓存）。

| 方法 | 权限 | params | result | 语义 |
|---|---|---|---|---|
| `discovery_sources` | read | `{}` | `{enabled, sources: [{id, kind, tier, status: 'ok'\|'stale'\|'unavailable', fetchedAt?, commit?, entryCount?, warnings?}]}` | 源清单 + 快照状态（UI tab 头 / 添加源引导） |
| `discovery_search` | read | `{query?, source?, tag?, offset?, limit?}` | `{items: RemoteSkillEntry[], total, stale?}` | 缓存内子串搜索（§6.1）；limit ≤50 |
| `discovery_preview` | read | `{source_id, id, version?}` | `{entry, content, auxFiles, truncated, warnings}` | 人类面预览（§6.2）；不写 loads、不做门 |
| `discovery_install` | write | `{source_id, id, version?, overwrite?}` | `{entry: SkillEntry, provenance, warnings}` | 七步管线（§6.3）；entry.trust=unknown |
| `discovery_refresh` | write | `{source_id?}` | `{sources: […同 discovery_sources]}` | 显式绕过 TTL 重取（缺省全部源） |
| `discovery_updates` | read | `{}` | `{updates: [{localId, sourceId, from, to}], checkedAt, warnings}` | 只报告（§6.4） |
| `discovery_update` | write | `{local_id}` | `{entry, provenance, from, to, warnings}` | 显式更新 = 重跑安装管线；信任锁照常 stale |

业务错误码（result 内，闭集）：`discovery_disabled` / `no_sources` / `unknown_source` /
`unknown_remote_id` / `registry_invalid` / `registry_fetch_failed` / `rate_limited` /
`preview_unavailable` / `download_failed` / `asset_too_large` / `checksum_mismatch` /
`already_installed` / `skill_name_mismatch` / `oversize` / `install_failed`。
参数非法走既有 `invalid_params` 信封（rpc.ts requireString / optionalCount 同款）。

超时与同步性：索引 fetch 30s、下载 120s（startDeadline 口径，bun AbortSignal.timeout
现态坑的既有解法）。技能包 ≤10 MiB，同步 RPC 通常秒级；若 gateway mutation 超时上限
盖不住最坏下载（marketplace 因此走 background job），实现期改用 CONTRACT-0.44 jobs
模式——开放问题 3（§13），不阻塞设计。