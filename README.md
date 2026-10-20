# dsh-depth-elevation

**把你的「升维询问」规则，从提示词约定变成 harness 级强制。**

[English](README.en.md) | 中文

---

## 问题

你写过这样的规则进 `AGENTS.md`：

> 当用户提出具备深度探索空间的重要任务时，主动询问是否按专家级标准重构。

但它不生效。因为**规则没有强制力**——模型每轮都读到它，也每轮都可以自己判断「这任务琐碎，跳过」。

实测数据（62 轮真实会话，来自本地 dsh 会话库）：

| 指标 | 数值 |
|---|---|
| 应触发的实质任务 | 24 个 |
| 模型自主触发 | **1 个独立任务** |
| 触发率 | ~4% |

模型推理轨迹里的原话：

> *"skip the elevation offer to avoid annoying"*

它不是不知道规则，是**自己决定不执行**。

## 方案

一个原生 Cordis 插件，在 `agent/pre-step` 拦截点插入判定：

```
用户输入 → [插件判定] → 命中硬判据?
                ↓ 是
         向消息批次追加一条带来源归因的指令
                ↓
         模型第一个动作必须是 ask_user_question
```

关键设计：**用 `additionalContext` 语义，不用 `reject`**。

`PreStepDecision.reject` 会**丢弃用户自己的消息**。漏一次询问可以补救，丢一条提示不可恢复——这个取舍是刻意的。

## 效果

同一份真实历史样本，插件判定结果（数字随会话增长，下表为撰写时快照）：

| 指标 | 结果 |
|---|---|
| 命中实质任务 | ~71%（撰写时 20/28） |
| 会话覆盖 | 撰写时 14/16 |
| 静默放行的 | 单点提问与追问，本就应豁免 |

跑 `node test/decide.test.mjs` 可看到你本机的最新数字——回放用的是你本地真实会话库，不是固定夹具。

## 安装

```sh
# 1. 取得源码
git clone https://github.com/zhang17798018728-del/dsh-depth-elevation.git
```

```cmd
:: 2. 链接到 profile（bundle 形式，无需写依赖）
mklink /J %USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-depth-elevation ^
      path\to\dsh-depth-elevation

:: 3. 加进 bundles —— 编辑 profile 的 package.json
::    "dsh": { "profile": { "bundles": [ ..., "dsh-depth-elevation" ] } }

:: 4. 重启 DSH
```

Linux/macOS 把 `mklink /J` 换成 `ln -s`。

### 开发期

junction 直接指向 clone 下来的目录，改代码立即生效，无需复制或重装：

```sh
python tools/bootstrap-peers.py    # 首次：从已装 harness 抽出 peer，供离线测试
npm test
```

改完开新会话即可验证——插件在会话启动时加载。

## 配置

挂载后每个键都能在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: depth-elevation
  config:
    enabled: true                      # 总开关
    verbs: ['设计', '方案', '分析']     # 触发动词表
    exemptExact: ['继续', '好']         # 精确豁免
    exemptPrefix: ['改成', '换成']      # 前缀豁免（追问编辑）
    minChars: 6                        # 单点查询上限
    listMinChars: 40                   # 列表算子句 (a) 的最小长度
    materialMinChars: 150              # 粘贴素材阈值
    deliverableMinChars: 20            # 交付请求阈值
```

## 验证

```sh
npm test
```

三套测试，每套针对不同的失效模式：

| 套件 | 检查什么 | 断言数 |
|---|---|---|
| `decide` | 判定核：18 条精选用例 + 配置项生效性 + 真实历史回放 | 18 + 3 + 回放断言 |
| `apply` | 挂载接线：seam 注册、来源归因、用户消息不被改、每会话去重 | 9 |
| `e2e` | 真实多消息批次：顺序、来源、下游 reject 透传 | 7 |

判定逻辑抽成 `lib/decide.js` 纯函数，**验证器测的就是出货代码**，不是重新实现的副本。

离线跑测试需要 peer（运行时由 harness 供给），抽取一次即可：

```sh
python tools/bootstrap-peers.py
```

## 已知边界

- 只判首轮输入；同一会话不重复拦截（防重复弹窗）
- 基于文本启发式，不做语义理解
- 宁可多拦一次，不静默跳过——这是刻意的

## 许可

[MIT](./LICENSE)

---

## English

**Full documentation: [README.en.md](README.en.md)**

Turn your "ask before you build" rule from a prompt convention into harness-level
enforcement. Measured over 62 real sessions, the prompt-only rule fired on **1 of
24** tasks that should have triggered it — the model's own reasoning said *"skip
the elevation offer to avoid annoying"*.

This plugin patrols `agent/pre-step` and attaches a sourced instruction to the
entering message batch when a prompt matches a hard trigger, requiring the model's
first action to be `ask_user_question`. It uses `additionalContext` semantics,
never `reject`, because rejecting a pre-step drops the user's own message.

Result on the same sample: 18/24 substantive turns gated (75%), 12/14 sessions
covered; the 2 misses are single-point questions that should stay exempt.

MIT licensed.
