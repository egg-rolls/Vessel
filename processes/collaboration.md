# 协作契约

> 2 人团队，一句话原则：**贾斯涵开发 → 自查通过 → 推送分支 → 李瑞审查合并。**

## 一、分支与提交

```
分支命名：  feat/<slug> ｜ fix/<slug> ｜ docs/<slug>
提交格式：  <type>(<scope>): <subject>    例：fix(core): 移除调试日志
```

## 二、开发到合并（每次必经）

```
git checkout -b fix/xxx main
# 编码...
bun run lint && bun run typecheck && bun test    # 1. 自查
git push -u origin fix/xxx                        # 2. 推送
# 通知李瑞合并                                    # 3. 通知
```

## 三、李瑞的审查（对照 CLAUDE.md §9）

```
[ ] 自查通过了吗？lint + typecheck + test 全绿？
[ ] 依赖方向正确？core 没引用 tui/config？
[ ] 没有硬编码 Key / console.log / NotImplementedError？
[ ] 没有违反 CLAUDE.md §6 红线？
[ ] 文档同步更新了没？
→ 通过 → git merge fix/xxx → git push → git branch -d fix/xxx → git push origin --delete fix/xxx
→ 不通过 → 标注原因 → 贾斯涵修复后重推
```

## 四、禁止

- 直接推 main
- 合并后修复（先修再合）
- Force push main
- 一个分支塞不相关的改动
