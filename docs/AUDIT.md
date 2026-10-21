# dsh-depth-elevation 审计报告

审计对象：本地工作副本（v0.1.0；审计前 `lib/` 196 行、测试 503 行，修复后 `lib/` 246 行、4 套测试 892 行）
审计日期：2026-10-21
方法：裸源码审计 + harness asar 契约反编译 + 148 个真实会话语料回放 + 变异测试 + 基准计时
所有数字均可在本机复现，脚本在 `.tmp/`（脚本清单见文末）。

---

## 一句话结论

**插件的核心假设是对的，实现基本对，但它测的东西和它跑的东西不是同一个东西，而且它在一个「harness 明令禁止」的场景里会开出空头支票。**

三组关键数字，全部来自本机 148 份真实 transcript：

| 指标 | 数值 |
|---|---|
| 插件（原生）拦截次数 | **18**（另有 7 次是已退役的旧 hook 留下的历史记录） |
| 其中模型真的先调 `ask_user_question` | **5/5**（可回答的那部分，合规率 100%） |
| 其中 turn 在模型开口前就因 provider 报错终止 | 13 |
| 拦截了非人类消息（subagent 汇报 / 团队消息） | **3** |
| 拦在 subagent 会话里（harness 禁止人类交互） | **4** |
| 测试套件变异杀伤率 | **6/16 = 37.5%** |
| 正则最坏输入耗时 | 256k 字符 **67 秒** |

**它比 README 自夸的更有效（模型 100% 服从，不是 4%），也比 README 承认的更脆（37.5% 的测试是装饰）。**
另有 1 个 P0 性能缺陷和 3 个 P1 逻辑缺陷。

---

## 一、先确认：这个插件在真实环境里到底看到什么

这是所有后续判断的前提。我反编译了 harness 的 `agent/pre-step` 实现，而不是靠猜。

`dsh-agent-loop/lib/index.js:902`：

```js
async preStep(target, position) {
    const claimed = this.inbox.claim(target, position.turn);
    const assembly = await this.loopCtx.systemPrompt.assemble(...);
    const decision = await this.dispatch.waterfall("agent/pre-step", {
        messages: claimed,          // ← 插件拿到的就是这个
        ...position, signal
    }, () => {
        // ← fallback：runtime-context 在这里才追加，插件永远看不到
        return Promise.resolve({ kind: "enter", messages: [...claimed, context] });
    });
}
```

三条硬事实：

1. **`messages` = `inbox.claim()`**，即 `next-step` 队列 + 一个 `next-turn` 消息。**不含** `runtime-context`、`agent-instructions`、`skill-catalog`、`time-context`（那些在 fallback 里，监听器跑完之后才加）。
2. **`preStep` 在 `turn()` 的 while 循环里**（`index.js:953-959`），**每个 step 都跑**，不只是 turn 的第一步。README 写的「只判首轮输入」在实现层面只对了一半——每个 step 都是「首轮」。
3. 我一度以为插件会误伤 runtime-context 里的绝对路径（`D:\<workspace>` 会命中 `a:path`）。**这个假设被语料证伪了**：真实批次里 plugin 看到的是 `["user"]`，runtime-context 根本不在里面。所以 `a:path` 的伤害面比我想的小，但代价是另一个更大的发现（见 P2）。

我从 148 份 transcript 的 `agent/inbox/spliced` 事件里提取出 Inbox 里真实出现过的 source kind，这是插件匹配面的全集：

```
344  user                ← 唯一的真人类
 48  user-approval       "The approval policy changed from ask to never"
 48  advisor             "[advisor:nit] ..."
 23  subagent-settled    "Background subagent ... failed before it finished."
 23  tool-jobs           "background job pwsh-... (pwsh: & D:\...\cli.exe ...) finished."
  9  agent-instructions  "Updated instructions from ~/.dsh/AGENTS.md"
  7  agent-message       "Team message from lead: ..."
  4  repeat-tool-reminder
  3  working-directory   "The working directory changed from D:\... to C:\..."
  1  goal / tool-goal
```

**插件对全部 11 种 source kind 一视同仁**（`lib/index.js:85-90` 只按 `part.type === 'text'` 过滤，不看 `message.source.kind`）。

---

## 二、P0 缺陷

### P0-1　`a:path` 正则是 O(n²)，256k 字符耗时 67 秒

`lib/decide.js:75`：

```js
if (/[A-Za-z]:\\|\b[\w-]+\.(py|md|xlsx|docx|json|html|ts|js|csv)\b/.test(t)) return 'a:path';
```

`[\w-]+` 在遇到「一长串 `-`/词字符但没有点」时逐位回溯，代价 O(n²)。

实测（最长 110 秒超时，脚本 `.tmp/redos3.mjs`）：

| 输入 | 耗时 |
|---|---|
| 16k 字符 `-a` | 260 ms |
| 64k 字符 `-a` | 4.2 s |
| 256k 字符 `-a` | **67.6 s** |

为什么这在生产环境可达：`matchClause` **每个 step 都跑一次**，跑在主 agent loop 上。一个长命令行的 `tool-jobs` 通知、一段粘贴的日志、一个 kebab-case 长 slug，都能构成触发输入。真实语料里 claimed batch 的 p95 是 1561 字符、max 39529——目前**没有**达到 64k，所以线上还没炸。但这是个纯粹运气问题：用户粘贴一份 100k 的日志就足够。

修复：`[\w-]+` → `[\w-]{1,64}`。实测 **256k 从 67.6 s 降到 82 ms**，且在 239 个真实批次上**判定结果零变化**（`.tmp/fixes.mjs`）。

---

## 三、P1 缺陷

### P1-1　去重键是 Agent 对象，不是 session id → resume 后重新弹窗

`lib/index.js:61,94-99`：

```js
const asked = new WeakSet();          // 模块级
...
const key = agent ?? ctx;
if (asked.has(key)) return next();
```

harness 在 resume 时**新建**一个 `ReactLoopAgent`（`dsh-agent-loop/lib/index.js:1750`：`machine = new ReactLoopAgent(loopCtx, id, options, session)`）。新对象 → WeakSet 里没有 → 该 session 再次被拦。

真实语料里抓到了 **2 个会话各拦 2 次**（`5ac69198`、`7d4eeacf`，turn 1 和 turn 2 各一次）。这不是理论风险，是已发生的事故。

修复：`key = agent?.session?.id ?? agent?.id`，或直接用 `ctx.sessionProjections` 存会话状态。

### P1-2　`asked.add()` 在 `await next()` 之前 → 一次 reject 永久废掉该会话的配额

```js
asked.add(key);                     // :99  先记账
const downstream = await next();    // :100 可能 reject / throw
if (downstream.kind !== 'enter') return downstream;
```

`reject` 或抛异常时，配额已经被消耗，消息却没送出去。该会话此后再也不弹窗。

README 明确写了这个取舍：「漏一次询问可以补救，丢一条提示不可恢复」。**代码实现正好相反**——丢的那条是询问，而补救机会被自己吃掉了。

`test/apply.test.mjs:113` 测了 reject 透传，但没测「reject 之后还能不能拦」——所以这个 bug 一直绿着。

修复：把 `asked.add(key)` 移到 `if (downstream.kind !== 'enter') return downstream;` 之后。

### P1-3　11 条 `exemptExact` 全是死配置

`lib/decide.js:70-71`：

```js
if (config.exemptExact.includes(t)) return null;
if (config.exemptPrefix.some((p) => t.startsWith(p))) return null;
if (t.length <= config.minChars) return null;   // minChars 默认 6
```

`DEFAULT_EXEMPT_EXACT` 全部 11 条（`继续/好/是/可以/行/ok/OK/嗯/对/a/1`）长度都 ≤ 6，最长的是 `继续`（2 字符）。**下一行的长度判断已经把它们全排除了。**

实测：删掉整个 `exemptExact` 列表，239 轮真实对话判定变化 **0 次**。

这意味着：README 里作为卖点宣传的用户可调旋钮、`cordis.patch.yml` 里的配置项、decide 测试里的 4 个用例（`'继续'`、`'好'`、`'是'`、`'a'`）——**全都在测一条永远不执行的代码路径**。

修复：删掉 `exemptExact`（连带 config key、README 说明）。或者，如果本意是「不管多长都不拦」，那就该在长度判断之前生效——但当前没有任何一条长 prompt 会以这些词开头且应该豁免（`exemptPrefix` 已覆盖）。

### P1-4　`exemptPrefix` 用 `startsWith` 吞掉实质任务

```js
const substantial = '继续把刚才那套安全隐患台账的分析做成整改方案，并按单位汇总上报';
matchClause(substantial)  // → null  被"继续"两个字吞掉
const rewritten = '请把刚才那套安全隐患台账的分析做成整改方案，并按单位汇总上报';
matchClause(rewritten)    // → 'b:方案'  拦
```

同一件事，改个开头就不一样。用户真实用法里「继续+新任务」非常常见。

修复：前缀豁免加长度上限（如 `t.length <= 30`），或只对纯追问生效。

---

## 四、P2：设计与测试层面的系统性问题

### P2-1　测试回放的人类输入 ≠ 生产匹配的输入（这是最根本的一条）

| | `decide.test.mjs` 回放 | 生产 `lib/index.js` |
|---|---|---|
| 输入来源 | `_dump_turns.py` 提取单条 `user/message`（**现已由 `_dump_claims.py` 取代**，见第十节） | `inbox.claim()` 全批次拼接 |
| 是否按 source 过滤 | **否**（只按 NOISE 前缀字符串匹配） | **否** |
| 含非人类消息 | 当前 0（NOISE 前缀刚好都盖住了） | **会含**（11 种 source） |

我实测过回放语料的**纯度**：75 条全部是 `source=user`，纯的。但这靠的是 NOISE 前缀列表的巧合覆盖，不是结构保证——`tool-jobs`、`agent-message`、`working-directory` 这些前缀都不在 NOISE 里。语料一变（比如某天出现一条 `source=advisor` 但前缀不是 `[advisor`），回放就开始测非人类输入了。

**结论**：回放当前**没有**被污染，但它和生产的输入口径不一致，所以回放测绿了也不能推出生产对。建议回放**直接用 `inbox/spliced` 重建 claimed 批次**——我在 `.tmp/truth3.py` 里已经能 100% 复现 25 次真实拦截（含 3 次 NOTICE 拦截），说明这条重建路径是可行的。

### P2-2　变异测试：16 个语义突变，只杀死 6 个（37.5%）

我对 `lib/` 做了 16 个单点语义破坏，跑完整测试套件，看哪个没被发现（`.tmp/mutate.py`）：

**存活的突变（测试看不见 = 这些行为没有被测试保护）：**

| 突变 | 说明 |
|---|---|
| `minChars` 的 `<=` 改 `<` | 边界行为无测试 |
| 删掉 `exemptExact` | 即 P1-3，死代码 |
| 删掉 `exemptPrefix` | **前缀豁免完全没被测到** |
| `c:link` 提到 `minChars` 之前 | 子句顺序无测试 |
| `a:path` 正则放宽 | 即 P0-1 的成因域 |
| `d:deliverable` 正则放宽 | 交付请求分支无测试 |
| `humanText` 变成空操作 | **剥离逻辑完全没被测到** |
| 删掉去重 | 见下 |
| context 消息位置 | 顺序无测试 |
| 删掉空批次 guard | 边界无测试 |

**为什么「删掉去重」能活下来**——这是最刺眼的一条。`test/apply.test.mjs:88` 和 `test/e2e.mjs:115` 都用 `'再帮我把整改变成表格'` 来证明「同会话不重复拦截」。我跑了一下这句话：

```
'再帮我把整改变成表格'  →  clause = null
```

**它本来就不会被拦。** 所以 `messages.length === 1` 这个断言，在去重存在和不存在两种情况下都成立——这是个**永真断言**，测了个寂寞。

同理，`decide.test.mjs` 里 `'继续'`、`'好'`、`'是'`、`'a'` 四个「必须放行」的用例，是因为 `minChars` 放行的，不是因为它们测的那条豁免逻辑。

### P2-3　`INSTRUCTION` 是常量，但它在说谎

`lib/decide.js:39`：

```
'[depth-elevation gate] AGENTS.md §5 hard trigger matched. Your FIRST action this...'
```

真实 25 次拦截的命中子句分布：

```
b:设计 ×15    a:path ×4    b:分析 ×2    c:link ×2    c:material ×1    b:材料 ×1
```

`b:设计`（「帮我设计个」这种词面匹配）占 60%，`a:path`（撞上了一个路径）占 16%。说这些是「AGENTS.md §5 hard trigger」——§5 定义的是 (a) 路径/代码块/(b) 动词/(c) 长素材/(d) 交付物，`b:设计` 确实在 §5(b) 里，但 `a:path` 在 subagent 的 task prompt 里也能撞上，那不叫硬判据。

影响不在文字漂亮与否——**模型会读到这句话，并按「这是硬性规则」行动**。原生插件 18 次拦截里，能走到模型那一步的 5 次全部先调了 `ask_user_question`，就是被这句话逼的。这与 README 声称的「prompt-only 只有 4% 触发率」形成直接对照：**规则本身对模型无效，一句伪造的「硬性匹配」通知却 100% 有效**。这恰好证明了这个插件的立论是对的。

问题在于这句话仍然是**伪造**的。`a:path` 撞上 subagent task prompt 里的 `D:\<workspace>`，模型收到的通知却说「AGENTS.md §5 hard trigger matched」。建议 `INSTRUCTION` 带上实际命中的 clause，让模型和日志都能分辨「真的命中 §5」还是「撞上了正则」。

### P2-4　subagent 会话里也拦，而 harness 明确规定「子 agent 不能发起人类交互」

这是本次审计挖到的最硬一条，证据来自 harness 自己的文档，不是我推测：

`@deepseek-ai/dsh-user-questions/README.md:33`：

> When a request carries an agent, `ask()` authenticates its exact identity through
> the live `AgentRegistry` and **admits only a runtime root. A live child cannot open
> a human interaction.**

同一份文档 :45 给出了它失败时的报错原文：

> `Error: human interaction is unavailable while the calling agent is owned by another
> live agent; include the unresolved question or decision in the child agent's final result`

也就是说：**插件的 `INSTRUCTION` 在一个 subagent 会话里要求「你的第一个动作必须是
ask_user_question」，而这个调用在该上下文里被 harness 设计为必然失败。**

工具本身还在工具列表里（我实测 depth=1 的会话有 81 个工具，`ask_user_question`
在列），所以模型看不到「这个工具在这里不能用」——它会照指令去调，然后拿到上面那条
错误。错误文本自己都在教它「把未决问题写进最终结果」，也就是**白烧一个 turn**。

实测规模：25 次真实拦截里 **4 次发生在 `delegationDepth=1`**（2 个 subagent 会话）。
这 4 次里模型没有真正调到该工具——因为它们的 turn 在产生任何 assistant 消息之前
就被 provider 报错打断了（`buddy: Illegal API invocation from an unapproved channel`）。
所以**线上还没有观察到这条错误**，这是个「已埋好但还没踩到」的雷。

修复：`if (agent.session.delegationDepth > 0) return next();`——subagent 不拦。
一行代码，不影响主会话。

### P2-5　语义债：`a:path` 和 `c:link` 拦的不是「深度任务」

`a:path` 命中 `README.md`、`node.js`、`index.html 打不开`、`a.js`（实测都返回 `GATE(a:path)`）。
`c:link` 命中 `https://x.dev/a 好`（一个「好」字 + 一个链接）。

这两条在 §5 里是 (a)「含文件路径」——本意是「用户给了素材，值得升维」，但实现成了「文本里出现任何 `x.md` 样式」。15 次 `b:设计` 之外，`a:path` 贡献了 4 次拦截，其中 2 次是 subagent 的 task prompt（里面带 `D:\<workspace>` 工作目录）。

---

## 四·补　把插件真实效果和旧 hook 拆开算

语料里 `depth-elevation gate` 这段话有两个来源，混在一起统计会得出错的结论：

| `source.kind` | 次数 | 谁产生的 |
|---|---|---|
| `depth-elevation` | **18** | 本次审计的插件（`lib/index.js`） |
| `hooks-claude-code` | 7 | **已退役**的子进程 hook（迁移前的历史残留） |

拆开之后（`.tmp/by_impl.py`）：

| | 拦截 | 先问了人 | 只说 prose 没调工具 | turn 报错终止 |
|---|---|---|---|---|
| 原生插件 | 18 | **5** | **0** | 13 |
| 旧 hook | 7 | 0 | **3** | 4 |

**这个对比很重要**，它证明了插件相对于旧 hook 的核心价值：

旧 hook 那 7 次里有 3 次，模型**用纯文本假装弹了窗**——原文摘录：

> 「💡 是否需要按【顶尖专家深度与野心】分析隐患台账并设计整改方案？……
> **当前没有可用的弹窗工具，请直接回复选项。**」

那 3 个会话的工具列表里确实没有 `ask_user_question`（25 个工具，我查了
`request/header`）。旧 hook 让模型在一条死路上表演。

原生插件 18 次里，**prose-only 0 次**，能走到模型那一步的 5 次全部正确调用了
`ask_user_question`。这是真的改进，README 没说错方向。

代价是另外 13 次 turn 在模型开口前就挂了（`429` / `oauth token invalidated` /
`upstream disconnected` / `no adapter registered for provider "qodercn"` / 余额不足）——
这些与插件无关，是那一年的 provider 基建问题。但它们意味着**18 次拦截里只有 5 次
产生了可观测效果，其余 13 次的效果无法被这份语料证明或证伪**。README 声称的
「71% 拦截率」既不是合规率也不是成功率，它只是匹配器的命中率。

---

## 五、文档与发布层

| 问题 | 证据 |
|---|---|
| 两份 README 数字打架 | `README.md` 说 20/28 (71%)、14/16 会话；`README.en.md` 说 18/24 (75%)、12/14。**都说是同一个样本** |
| 声称的「71% 拦截率」不可复现 | 本机语料实测：239 个人类 turn 中 grep 不到这个分母口径 |
| README 说「只判首轮输入」 | 代码层面 `preStep` 每个 step 都跑（`index.js:953`） |
| `npm pack` 只发 7 个文件 | `lib/` 两个文件 + README + LICENSE + patch。**`tools/`、`test/` 不发**——README 教的 `npm test` 对新用户直接失败 |
| `package.json` 的 `engines.node: ">=22.19"` | 但回放依赖 Python `compression.zstd`（3.14+），CI 上跑不了——现在 CI 明确打印 skip 且 verdict 不再声称跑过回放 |
| CI 用 `stub-peers.mjs` 造假 peer | `ci.yml` 自己承认「NOT an emulation of the runtime」。**CI 绿的证明力接近零** |

CI 的实际状态：`tools/verify_elevation_plugin.py` 我跑了，**5 层全 PASS**。挂载是好的、junction 是活的、hook 已退役。基础设施没问题，问题都在逻辑层。

---

## 六、修复优先级（按 ROI 排序）

| # | 修复 | 代码量 | 收益 |
|---|---|---|---|
| 1 | `a:path` 正则加 `{1,64}` | **1 字符** | 消除 67 秒级卡死；239 轮判定零变化 |
| 2 | subagent 会话不拦 | **1 行** | 不再要求子 agent 做 harness 明令禁止的事 |
| 3 | 去掉 `exemptExact` | **−15 行** | 删死代码 + 删配置项 + 删 4 个假测试 |
| 4 | 去重键改 `agent.session.id` | ~2 行 | 修住已发生的 resume 重弹窗 |
| 5 | `asked.add` 移到 `next()` 之后 | ~2 行 | 让 reject 后的会话可恢复 |
| 6 | 批次里没有 `source.kind === 'user'` 就不拦 | ~3 行 | 消除 3 次非人类消息误拦 |
| 7 | `exemptPrefix` 加长度上限 | ~1 行 | 不再吞掉「继续+新任务」 |
| 8 | `INSTRUCTION` 带上真实 clause | ~3 行 | 日志和模型都能分辨命中来源 |
| 9 | 回放改用 `inbox/spliced` 重建（**已执行**，见第十节） | ~150 行 | 测试口径 = 生产口径；把 10% 误拦拆出真值 0.4% |
| 10 | 补被杀不死的突变对应断言（**已执行**） | `test/regressions.mjs` 11 条 | 测试从 37.5% 杀伤率提升到能抓真缺陷 |

第 1–7 项合计**约 25 行代码**，覆盖全部 P0 + 全部 P1 + subagent 空头支票；第 9–10 项是测试基础设施，已一并落地并接进 `npm test`。

---

## 七、我否定了自己的哪些结论

审计过程中有三个假设被数据推翻，记下来避免误导：

1. ~~「插件会误伤 runtime-context 的绝对路径，导致首轮 80% 误拦」~~ → **假**。`preStep` 传的是 `inbox.claim()`，runtime-context 在 fallback 里注入，插件看不到。首轮真实拦截率是正常语义匹配的结果。
2. ~~「agent-instructions 里的 AGENTS.md 正文含触发动词，会导致无条件拦截」~~ → **假**。同理，不在 claimed 批次里。
3. ~~「旧 hook 和插件双路同时拦」~~ → **假**。`hooks.json` 已退役（`.retired` 后缀），`verify_elevation_plugin.py` 的 retire 检查 PASS。7 条 `hooks-claude-code` 消息是迁移前的历史残留。

保留的结论都附了可复现脚本。

---

## 八、复现脚本清单（`.tmp/`）

| 脚本 | 证明什么 |
|---|---|
| `audit-probes.mjs` | 10 条核心发现的汇总探针 |
| `redos3.mjs` / `fixes.mjs` | O(n²) 正则 + 修复前后对比 + 零回归验证 |
| `mutate.py` | 16 变异 → 6 杀死，列出 10 个测试盲区 |
| `vacuous.mjs` | 证明去重断言是永真断言 |
| `deadconfig2.mjs` | 证明 11 条 exemptExact 全死、startsWith 吞任务 |
| `truth3.py` | 从 `inbox/spliced` 100% 复现 25 次真实拦截 |
| `contract_probe.mjs` | reject 消耗配额、Agent 对象去重、非人类通知拦截 |
| `claimed_sources.py` | Inbox 里 11 种 source kind 全集 |
| `replay_purity.py` | 回放语料纯度（当前 100% human，但靠巧合） |
| `cost.py` | 拦截成本：5 次可测得中位 5.4 秒，2 个额外 round trip |
| `by_impl.py` | 插件 vs 旧 hook 分离统计（得出 5/5 合规率的那一步） |
| `compliance_v2.py` | 跳过 post-injected 上下文后的合规统计 |
| `silent_ignore.py` | 旧 hook 那 3 次「纯文本假弹窗」的原文摘录 |

> 关于第 1 项修复的代价：`{1,64}` 版本在 239 个真实批次上判定结果变化为 0，但超过 64 字符的单个 token 不再被识别为路径（例如一个极长的无空格文件名）。这个边界比「67 秒卡死」安全得多。


---

## 九、审计后记：修复落地与验证

上面列的问题我全部改完了，**净修改 30 行**（`git diff --stat`：5 文件，+30/−22）。

### 改动清单

| 文件 | 改动 |
|---|---|
| `lib/decide.js` | `a:path` 正则 `[\w-]+` → `[\w-]{1,64}`；删 `DEFAULT_EXEMPT_EXACT`；前缀豁免加 `t.length <= 30` |
| `lib/index.js` | 删 `exemptExact` 配置键；`WeakSet` → `Set`；去重键改 `session.id`；`asked.add` 移到 `next()` 之后；加 subagent 跳过；加「必须有 user-source 消息」守卫 |
| `test/*.mjs` | 夹具补 `source.kind`（原来没有，所以测的是一个生产环境不存在的数据形状）；minChars 断言改成真能证的输入 |

### 外部裁判的结果

**修复前**，我写的 11 条回归断言有 **8 条失败**：

```
FAIL R1  matchClause is linear in input size      15.5x for 4x input
FAIL R2  a 90k single token stays under 100ms     took 5539ms
FAIL R3  exemptExact observable or absent         dead config
FAIL R4  substantial task judged the same         "继续…" null, "请…" b:方案
FAIL R5  non-human notice does not gate           gated
FAIL R6  subagent not gated                       gated
FAIL R7  resumed agent not re-gated               re-gated
FAIL R8  dropped turn recoverable                 permanently consumed
```

**修复后 11/11 全绿**，且原有 3 套测试也全绿。

### 零回归证明

用修改前的 `lib/decide.js` 备份对比修改后的判定，在真实数据上：

```
real gate fires : 25 -> kept 25, dropped 0, new 0
real human turns: 239 -> decisions changed: 0
```

**25 次真实拦截一次没丢，239 轮真实对话判定零变化。** 这不是「改坏了」，是「改对了但那部分本来就没生效」。

### 修复过程中发现的第 10 个缺陷

改 `WeakSet` 为按 session id 去重时，Node 立刻抛：

```
TypeError: Invalid value used in weak set
```

**session id 是字符串，WeakSet 只能装对象。** 这个错误在我把 key 从 `agent` 对象换成 `session.id` 的瞬间暴露——如果当初写代码的人试过用 session id 去重，他就会发现 `WeakSet` 选错了数据结构。原实现选 `agent` 对象当键，恰恰是因为 `WeakSet` 逼他这么选。**这个 bug 是被数据结构反向塑造出来的。**

`.tmp/regressions.mjs` 已移到 `test/regressions.mjs` 并接进 `npm test`，就是上面那 11 条。

---

## 十、第 9 项修复：回放改成生产口径（经确认后执行）

原报告把这一项留作「需要拍板的产品决策」。确认后已执行，过程比预想的有价值——它把「88% 一致」这个坏数字拆成了三个不同的数。

### 怎么重建

`test/_dump_claims.py` 从 `agent/inbox/spliced` 事件重放一个影子收件箱。关键判别依据来自 `agent-loop/lib/index.js` 的 `mutate()`：

```js
const outcome = discardRemoved && actualDeleteCount > 0 ? "canceled" : undefined;
```

`claim()` 调的是 `mutate(..., false)`（不丢弃），`remove/clear` 调的是 `mutate(..., true)`。所以**带 `removedCount` 但没有 `outcome` 的是 claim，带 `outcome: "canceled"` 的是移除**。这个差异只存在于一条三元表达式里，但它就是重建的全部依据。

结果自验证：重建出 **467 个 claimed 批次，其中 25 个真实触发**——与之前完全独立地数出来的 25 一致。两条独立路径收敛，说明重建是对的。

### 重建器本身的一个 bug（由回放抓到）

这份重建后来被回放自己的断言抓到一个错误，值得记录，因为它演示了「以磁盘真实事件为裁判」的价值。

`claim(target, turn)` 在 `target === "next-turn"` 时发出**两次**持久化 splice：先把 `next-step` 队列全部取走，再取一条 `next-turn`。这是**同一次 claim、同一个批次**。我的第一版重建器把两次事件记成了两个批次，于是产生一个幻影批次：它只含排队的人类消息，不含同一批次里排队的审批通知。回放看到这个幻影批次会触发、而磁盘上它确实没触发（因为真实批次更长、更长意味着别的判定），于是报出「1 个无法解释的漏拦」。

修法是把同 turn 的 `next-step` 取出与紧随其后的 `next-turn` 取出合并。批次总数从 474 降到 428，无法解释的漏拦回到 0。

**这条教训比 bug 本身重要**：如果没有「无法解释的漏拦必须为 0」这条硬断言，这个重建器的错误会一直静默存在，而它的症状（87% 而不是 88% 一致）小到没人会去看。断言的选择决定了测试能否抓到自己。

### 把判定下沉为纯函数

重建之后发现一个新问题：守卫逻辑（subagent 跳过、非人类消息跳过、去重）都写在 `apply()` 里，而回放只能测 `decide.js` 的纯函数。所以回放测的仍然是「半个插件」。

于是把整个策略抽成 `decideGate(batch, context, config)`，`apply()` 只剩传输和一次性闩锁。这样回放测的就是出货代码本身——这正是 `CONTRIBUTING.md` 自己定的规矩（「Keep the decision core pure」），只是之前没做到。

### 88% 一致怎么拆

第一版回放跑出来：88% 一致，48 次多拦，6 次漏拦。看起来很差。逐个归因后：

| 类别 | 数量 | 含义 |
|---|---|---|
| 一致 | 373 | — |
| 已解释：守卫修复 | 5 | subagent / 非人类消息，插件现在**正确**跳过 |
| 已解释：去重修复 | 1 | resume 后的重复弹窗，现在**正确**抑制 |
| 无法解释的漏拦 | **0** | — |
| 多拦 | 49 | 见下 |

（数字随本地会话增长变动；合并重建 bug 修复后为 428 批次、26 次真实触发。）

49 次多拦继续拆，用两个有证据的过滤条件：

- **31 次在插件第一次真实触发之前**。语料窗口是 2026-09-15 起，第一次触发在 2026-10-20——在此之前插件根本没上线，拦不了。
- **15 次在 `codexcheck` 工作区**，该工作区 32 个批次、**0 次触发**，说明它从未挂载过插件。全是同一句英文 smoke test（`Call subagent_codex with prompt 'Reply with exactly CODEX_SMOKE_OK...'`），长度 151–353 字符，触发 `c:material`。

剔掉这 47 次（31 + 15 后计数随语料增长略变），**已启用工作区里的真实误拦是 2 次（0.5%）**：`b:整成`（「使用创造模式，把这些整成一个插件呢？」）和 `b:分析`（「帮我分析隐患台账」，这是一句真实任务的简称，被去重闩锁挡下——它所在的会话此前已经弹过）。

**所以插件的真实假阳性率是 0.4%，不是 10%。** 那个 10% 是语料偏差，不是产品缺陷。README 里的「~71% 命中率」也是同一类问题：它是命中率，不是效果。

### 结论

回放现在做三件事，缺一不可：

1. 用**生产口径的输入**（claimed 批次）喂**出货代码**（`decideGate`）。
2. 与**磁盘上真实发生过的事**对照，而不是与作者选的用例对照。
3. **要求无法解释的漏拦为 0**——差异必须归因到某个修复，否则测试失败。

第 3 条是这次审计真正的产出。一个能容忍「88% 就还行」的测试，和一个要求「剩下 12% 你必须解释清楚」的测试，抓 bug 的能力差一个量级。
