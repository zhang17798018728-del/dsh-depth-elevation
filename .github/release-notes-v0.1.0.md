## 它解决什么

`AGENTS.md` 里的「主动升维询问」规则没有强制力。模型每轮都读得到，也每轮都可以自己判断「这任务琐碎，跳过」。

62 轮真实会话实测：24 个应触发的实质任务里，模型只自主触发了 **1 个**。推理轨迹原话是 *"skip the elevation offer to avoid annoying"*。

这个版本把规则变成 harness 级拦截：命中硬判据时，向消息批次追加带来源归因的指令，强制模型第一个动作是 `ask_user_question`。

同一份样本上的结果：**约 71% 的实质任务被命中**，14 个有实质任务的会话覆盖 14 个；未命中的是单点提问和追问，本就该豁免。跑 `node test/decide.test.mjs` 可看到你本机的最新数字——回放读你本地真实会话库。

## 关键设计

**用 `additionalContext`，不用 `reject`。**

`PreStepDecision.reject` 会**丢弃用户自己的消息**。漏一次询问下一轮可以补，丢一条提示不可恢复。

**判定核是纯函数。**

`lib/decide.js` 不含 I/O、时钟、进程状态。所以验证器回放 62 轮真实历史时，测的是**出货代码本身**，不是重新实现的副本。这也是为什么下面那些数字可信。

**每会话只拦一次。**

早期无状态版本在单个 24 轮会话里触发了 4 次，后续每个追问都被拦。现在用会话级标记，一次会话只问一次。

## 验证

```
PASS  decide   18 精选用例 + 配置项生效性 + 真实历史回放
PASS  apply    9 项接线断言
PASS  e2e      7 项消息批次断言
PASS  mount    profile 挂载确认
PASS  source   运行时路径是指回源码的活 junction
PASS  retire   旧 hook 已退役，无双拦截
```

CI 在 Ubuntu 与 Windows 上跑 Node 22 / 24，全部通过。

## 安装

```sh
git clone https://github.com/zhang17798018728-del/dsh-depth-elevation.git
```

```cmd
mklink /J %USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-depth-elevation ^
      path\to\dsh-depth-elevation
```

然后加进 profile 的 `bundles` 数组，重启 DSH。

## 已知边界

- 只判首轮输入，同会话不重复拦截
- 文本启发式，不做语义理解
- 宁可多拦一次，不静默跳过——刻意的

## 验证方式

```sh
npm test                              # 三套测试
python tools/bootstrap-peers.py       # 首次：抽 peer 供离线测试
```

---

**完整文档**：[中文](https://github.com/zhang17798018728-del/dsh-depth-elevation#readme) · [English](https://github.com/zhang17798018728-del/dsh-depth-elevation/blob/main/README.en.md)
