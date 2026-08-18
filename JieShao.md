用户希望我写一篇知乎风格的技术性文章，介绍 TianShu (天枢) 插件。要求：
1. 背景清楚
2. 亮点突出
3. 使用帮助明确
4. 不要太书面化（口语化一点，知乎风格）
5. Markdown 输出

我不需要创建文件，用户只是让我输出一篇文章。直接在回复中用 Markdown 输出即可。

让我写一篇有知乎味道的技术文章。
# 我给 DeepSeek Harness 造了个"事后诸葛亮"——天枢（TianShu）失败根因分析器

> 做过 Agent 开发的都知道，Agent 跑挂了不可怕，可怕的是你不知道它为啥挂的。

## 背景：一个让人头疼的场景

用 DeepSeek Harness（下面简称 DSH）跑 Agent 任务，总会遇到一些让人摸不着头脑的时刻：

- 跑着跑着 Agent 开始反复调用同一个工具，跟死循环似的
- 一个 turn 突然因为 max-tokens 被截断了，但你看不出是哪一步爆的
- Sandbox 拒绝了某个操作，Agent 却当没发生过继续往下走
- 最离谱的一次：Agent 调了一次工具，烧了 5 万 input tokens，只产出 80 个 output tokens，然后 gas 耗尽

每次遇到这种事，排查流程是这样的：

1. 打开 session log
2. 人眼扫一遍几百条事件
3. 找到出错的位置
4. 猜原因
5. 改 prompt / 换模型 / 加约束
6. 再跑一次，可能又挂在别的地方

这个循环做多了就会想——**能不能让机器自己告诉我它为啥挂了？**

所以做了 **天枢（TianShu）**。名字来自北斗七星里的天枢星，古代用来定位北极星的方向，这里取"定位故障根因"的寓意。

## 亮点：它跟其他 debug 工具有什么不一样

### 1. 规则引擎 + LLM 双层诊断，免费 + 深度两不误

这是天枢最核心的设计。两层诊断分开跑：

**第一层：规则引擎（10 种失败模式，零 LLM 调用）**

规则引擎同步运行，不花一分钱 API 费用，覆盖了 Agent 场景下最常见的 10 种死法：

| 失败模式 | 说明 |
|---|---|
| `tool-error-loop` | 同一个工具连续报错 N 次 |
| `tool-result-loop` | 同一个工具 + 完全相同的参数被调用 N 次（真·死循环） |
| `max-tokens-truncated` | turn 因为 token 超限被截断 |
| `sandbox-denied` | 工具结果里出现权限/沙箱拒绝 |
| `approval-blocked` | turn 被阻塞（等用户审批但没等到） |
| `llm-error` | LLM 直接报错 |
| `llm-aborted` | LLM 被中断 |
| `prompt-injection-signal` | 用户输入里有 prompt 注入特征 |
| `token-burn` | 单次调用 input > 50k 且 output < 100（典型的烧 token 不干活） |
| `no-progress` | 连续 N 步 assistant 输出越来越短（陷入停滞） |

每条规则触发后，会给出 **evidence（证据）** 和 **suggested fix（建议修复方向）**。比如 `tool-error-loop` 触发时，会列出是哪个工具、错了几次、前几次的错误信息是什么。

**第二层：LLM 深度诊断（可选）**

规则引擎跑完后，可以把所有 findings 打包丢给 LLM，让它做一次"二次诊断"：

> "这个 session 失败了，规则引擎发现了这 3 个问题，请基于这些证据 + 完整事件流，告诉我真正的根因是什么，以及如果要 fork 这个 session 重跑，应该在哪个节点 fork、改什么。"

这里最关键的一点：**LLM 调用复用 session 自己的模型路由**。也就是说——

- 不需要额外配 API key
- 不需要额外的 provider
- 用 session 已经选好的模型直接跑

DSH 把 session 的模型路由信息存在 `assistant/message` 的 provenance 里，天枢直接读出来复用，零配置开箱即用。

### 2. 四种触发方式，覆盖所有使用场景

这是另一个我很在意的设计点。**Debug 工具的价值取决于它在你工作流的哪个环节能被用到**。天枢支持四种触发方式：

**A. Web UI 面板（手动，交互式）**

会话头部出现一个 `⚕︎ Diagnose` 按钮，点一下就弹出诊断面板。面板里有：
- 所有 findings 列表（按严重级别排序）
- 工具调用热力图（哪个工具被调用最多、出错最多）
- Fork 点建议（在哪个事件之后 fork 最合适）
- 完整的 Markdown 报告
- "LLM deep diagnosis" 开关

**B. 自动触发（hands-off）**

默认开启。订阅 `turn/end` 事件，只要 reason 是 `error` / `blocked` / `interrupted` / `aborted` 之一，就自动跑一次分析：
- Markdown 报告写到 `~/.dsh/tianshu-reports/<sessionId>-<timestamp>.md`
- 内存里缓存一份（Web UI 可以读）
- 发一个 `tianshu/report` 事件，其他插件可以订阅

完全不需要你做任何事，跑挂了报告就躺在那里等你。

**C. Agent 工具（自我诊断）**

这个是最有意思的。Agent 自己可以调用 `diagnose_session` 工具：

```
diagnose_session(sessionId: "<session-id>", useLlm?: boolean)
```

返回结构化的诊断摘要。这意味着 Agent 可以：

1. 跑一个任务
2. 跑挂了
3. 调 `diagnose_session` 看自己为啥挂的
4. 根据建议的 fork 点重跑

完全闭环，不需要人介入。而且因为规则引擎不调 LLM，所以 Agent 自我诊断这一步本身是免费的。

**D. 编程式调用（其他插件集成）**

其他 DSH host 插件可以直接读 in-process 服务：

```typescript
// 任何声明 inject: ['tianshu'] 的插件
const report = await ctx.tianshu.analyze(sessionId, { useLlm: true })
const cached  = await ctx.tianshu.getReport(sessionId)
```

### 3. Host ↔ Browser 桥接的工程细节

这是踩坑最多的一部分，值得单独说。

DSH 基于 Cordis 微内核，主机进程和浏览器是两个独立的运行时。`ctx.provide('tianshu', api)` 是**进程内**的服务注册，不会自动跨越进程边界到达浏览器。

第一版天真地以为浏览器能读到 `ctx.tianshu`，结果控制台直接报：

```
cannot get property "tianshu" without inject
```

解决方案是用 DSH 的通用 Connection RPC 通道。主机侧注册一个 `/tianshu` channel：

```typescript
ctx.connection.rpc.handle('/tianshu', {
  authority: 'trusted-host',
  handler: async ({ endpoint, payload }) => { /* dispatch */ }
})
```

浏览器侧通过 `ctx.connection.rpc.call('/tianshu', endpoint, payload)` 调用。不用单独配 API key、不用代理，直接骑 DSH 已有的信任边界。

另外一个坑是**浏览器 bundle 的加载方式**。DSH 的 client module 系统是 lazy CJS 模型——bundle 执行时只注册一个 factory，真正的模块代码在 materialization 时才跑：

```javascript
window.__ModuleLoader__.load({
  id: "dsh-tianshu-analyzer",
  factory: (require) => {
    var module = { exports: {} };
    // ...真正的代码...
    return module.exports;
  }
})
```

tsdown 配置里要手动用 banner / intro / footer 把 ESM 产物包成这个 CJS factory 形式，否则就会报 `loaded without registering via __ModuleLoader__.load`。

## 使用帮助：从 0 到 1 跑起来

### 前置条件

- Node.js ≥ 20
- pnpm ≥ 9
- DeepSeek Harness（`dsh` CLI 或源码克隆）

### 三步启动

```sh
# 1. 克隆 + 安装
git clone https://github.com/jiel521125/dsh-anlayzer.git tianshu-analyzer
cd tianshu-analyzer
pnpm install

# 2. 构建（产出 lib/ 下的 host ESM 和 browser CJS bundle）
pnpm build

# 3. 加载到 DSH
dsh web --patch ./cordis.patch.yml
```

打开 http://127.0.0.1:3080，随便选一个 session，会话头部就会出现 `⚕︎ Diagnose` 按钮，点击就出面板。

### 配置项

所有配置都在 `cordis.patch.yml` 里，关键字段：

| 配置 | 默认值 | 作用 |
|---|---|---|
| `autoTrigger` | `true` | 是否在 turn 失败时自动跑诊断 |
| `autoTriggerReasons` | `[error, blocked, interrupted, aborted]` | 哪些 reason 触发自动诊断 |
| `llmDiagnose` | `true` | 是否启用 LLM 深度诊断 |
| `llmMaxTokens` | `2048` | LLM 诊断调用的输出上限 |
| `llmTimeoutMs` | `30000` | LLM 调用超时（毫秒） |
| `provider` / `model` | *(unset)* | 覆盖模型路由；不填就复用 session 自己的 |
| `reportDir` | `~/.dsh/tianshu-reports` | Markdown 报告保存位置 |
| `keepReports` | `50` | 最多保留多少份报告（旧的自动清理） |

### 规则阈值调整

如果默认阈值不合适，可以单独调每条规则。比如你想把 tool-error-loop 的触发次数从 3 改到 5：

```yaml
rules:
  toolErrorLoop:
    enabled: true
    threshold: 5
```

完整规则阈值表在 README.md 里有，这里不重复贴了。

### 排查常见问题

**问题 1：点了 Diagnose 按钮没反应**

打开浏览器控制台看错误。如果是 `cannot get property "tianshu" without inject`，那是浏览器侧 client 的 inject 数组没声明 `connection`。这是 v0.1.0 的 bug，v0.2.0 已经修了。

**问题 2：诊断跑着跑着报 `cannot get property "sessionQuery" without inject`**

这是主机侧的问题。Host 插件的 `inject` 必须包含 `sessionQuery` 和 `sessions`：

```typescript
export const inject = ['tools', 'llm', 'sessionQuery', 'sessions']
```

少一个都会在第一次访问时报这个错。

**问题 3：LLM 诊断超时**

把 `llmTimeoutMs` 调大，或者直接关掉 LLM 诊断（`llmDiagnose: false`），规则引擎的输出已经够用了。

## 一些设计取舍的思考

做这个插件的过程中有几个决策点值得说一说。

**为什么不用专门的诊断模型？**

因为 session 失败的"上下文"很重要——同一个工具错误，在数学任务里和在代码任务里的含义完全不一样。复用 session 自己的模型，意味着诊断 LLM 看到的上下文跟失败时 Agent 看到的是一致的，判断会更准。而且不用额外花钱配 key，这是巨大的工程便利性。

**为什么规则引擎不调 LLM？**

两个原因。第一，规则引擎要支持 Agent 自我诊断（Agent 调 Agent），如果每次诊断都烧 token，Agent 会陷入"诊断-失败-再诊断"的 token 螺旋。第二，10 种失败模式都是**结构化的、可枚举的**，规则匹配的准确率比 LLM 高，速度也快（同步执行 vs 几秒的 LLM 调用）。

**为什么把报告存成 Markdown 文件而不是数据库？**

因为 Debug 是一个高度协作的场景。你想把报告贴到 GitHub Issue 里、贴到飞书群里、给同事看一眼——Markdown 是最通用的格式。存数据库反而要做导出功能。简单粗暴的文件系统反而最实用。

## 写在最后

天枢 v0.2.0 已经开源在 GitHub：
**https://github.com/jiel521125/dsh-anlayzer**

MIT 协议，欢迎 PR、提 issue、或者只是在你的 DSH 工作流里试用一下。如果有踩到其他失败模式，欢迎在 issue 里告诉我，可以加进规则引擎里。

做 Agent 开发这一年，最大的感受是：**Agent 的可靠性是个系统工程，不是调 prompt 能解决的**。每一次失败都应该被结构化地记录、分析、归因，下一次才能跑得更稳。天枢就是奔着这个目标做的小工具，希望能帮到同样在踩坑的你。

---

*作者：周龙（天枢智能 / Tianshu Intelligent）*
*微信：longling1031*
*知乎：[@tianshu_cn](https://www.zhihu.com/people/tianshu_cn)*