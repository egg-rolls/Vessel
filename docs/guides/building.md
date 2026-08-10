# 构建与发布

## 构建

```bash
bun run build          # 构建所有包（npm 包产物，供 npm publish）
```

构建输出：
- `dist/` — 各包的编译产物（npm 包发布内容）

> 分发走 npx（弃单二进制，见 ADR-006）：不再编译 `bun build --compile` 单二进制；发布 npm 包后用户 `npx vessel` 即用。

## 类型检查

```bash
bun run typecheck      # tsc --noEmit
```

## Lint & Format

```bash
bun run lint           # Biome check
bun run format         # Biome format --write
```

## CI 流水线

CI（`.github/workflows/ci.yml`）自动运行：

```
push → Install → Lint → Typecheck → Test → Build
```

四项全部通过才算 CI 绿。

## 运行

```bash
bun run start.ts       # 开发 REPL
bun test               # 运行测试
```
