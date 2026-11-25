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