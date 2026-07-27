# 构建与发布

## 构建

```bash
bun run build          # 构建所有包
bun run build:binary   # 编译为单二进制（Bun --compile）
```

构建输出：
- `dist/` — 各包的编译产物
- `dist/vessel` — 单二进制可执行文件

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
push/PR → Install → Lint → Typecheck → Test → Build
```

四项全部通过才算 CI 绿。

## 版本发布（pre-MVP 暂不启用）

当前 pre-MVP 阶段：
```bash
# 暂无正式发布
# 开发用 bun run start.ts
# 测试用 bun test
```
