# Agent Hub

> **把多个 AI agent 接到同一张桌子上。** 打开即用，关闭即停。
> 终端风格界面 · Electron · Windows

<!-- 截图待补：docs/screenshot.png（现有截图含本机路径，确认后再放） -->

---

## 这是什么

如果你手上不止一个 AI agent（比如 WorkBuddy 和 Codex），平时的痛点是：
它们各干各的，你想把 A 的结果交给 B 看，只能自己复制粘贴。

Agent Hub 在中间摆一张桌子：**每个 agent 各接一条长连接，谁也不指挥谁**，
路由全在中继里，agent 之间甚至不知道对方存在。你在同一个窗口里切换收件人发消息，
各家的输出按颜色和时间线汇在一起。

```
   WorkBuddy  ←— ACP (HTTP + SSE) ——┐
                                    ├——  Agent Hub  ——→  一个终端界面
   Codex      ←— WebSocket + RPC ——┘
```

## 它解决什么

- **一个窗口看多家 agent 的输出**，不用来回切窗口复制粘贴
- **每条腿可以指向不同的工作空间**（顶栏每个 agent 各有一个下拉框）
- 消息**留档**（`relay.jsonl`），需要时一键清空
- 想接**第三种 agent**？不用改代码，加一段配置就行 —— 见下面「怎么接新的 agent」

---

## 快速开始

### 方式一：直接用 exe（推荐）

1. 下载 `AgentHub.exe`（约 100 MB，portable，**免安装**）
2. 双击打开
3. 如果界面提示找不到 `codex.exe`，点右上角 **「设置」→「选择…」** 指一下位置即可 ——
   **不需要看任何文档**

### 方式二：从源码跑

```bash
git clone https://github.com/xieronghuan/agent-hub.git
cd agent-hub/app
npm install
npm start
```

Windows 上也可以直接双击仓库根目录的 **`启动AgentHub.cmd`**。

### 前置条件

- **Windows**（第一版只支持 Windows）
- 至少装一个要接的 agent：
  - **WorkBuddy** —— 中继会自动发现它的 ACP 端口（端口每次启动都可能变，所以是动态发现的）
  - **Codex** —— 中继会自动帮你起 `codex app-server`

---

## 界面与用法

- **顶栏**：每个 agent 一组「`●` 名字 `[工作空间▾]`」
  - 圆点**颜色 = 该 agent 的标识色**（和消息正文的颜色一一对应，方便认人）
  - 圆点的**明暗表示连上没有**（变亮 = 已连接）
- **底栏**：左边选「发给谁」，中间输入内容，回车发送
- **右上角**：「设置」「清空留档」两个按钮，点就行

命令（在输入框里打）：

| 命令 | 作用 |
|---|---|
| `/ws` | 列出所有工作空间 |
| `/ws <编号\|路径>` | 切换当前默认目标的工作空间 |
| `/t <agentId>` | 切换底栏默认发给谁 |
| `/status` | 看各腿状态 |
| `/clear` | 清屏 |
| `/help` | 看帮助 |

---

## 设置：不用改代码

所有与本机相关的信息（路径、代理、端口）**都不写在源码里**，统一按同一条链路找：

> **环境变量 → `~/.agent-hub/config.json` → 自动探测 → 弹出「设置」窗口让你自己填**

界面上点「**设置**」就是这个文件的图形入口。能改这些东西：

| 项 | 对应环境变量 | 说明 |
|---|---|---|
| `node.exe` 路径 | `WB_NODE` | 留空则自动探测 |
| `codex.exe` 路径 | `CODEX_CLI` | 留空则自动探测；没装 Codex 可以不管 |
| 代理地址 | `RELAY_PROXY` | 留空则自动探测本机常见代理端口（7897 / 7890 / 10809 / 1080 …）。**在中国大陆访问 Codex 通常需要代理** |
| Codex 端口 | — | 默认 `8899` |

**每台电脑各存各的**，配置文件不会跟着仓库走。

数据都放在 `~/.agent-hub/`：

| 文件 | 内容 |
|---|---|
| `config.json` | 本机设置（上面那些） |
| `relay.jsonl` | 消息留档（可用界面「清空留档」清掉） |
| `relay.log` | 运行日志，排查问题先看它 |
| `<agentId>-app.log` | 各 agent 自带服务端的日志 |

---

## 怎么接新的 agent（核心）

整个项目是**配置驱动**的：中继与界面都按清单渲染，加一条腿不用动 `relay-server.js` 和界面代码。

配置写在 `~/.agent-hub/config.json` 的 `agents` 数组里
（不改配置文件的话，也可以直接改源码里的 `app/agents.js`，两者结构完全一样）。

### 每条腿的字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识，界面 / 命令 / 日志都用它 |
| `name` | | 显示名 |
| `color` | | 该 agent 的标识色（顶栏圆点 + 正文都用它，两边对应） |
| `kind` | ✅ | 接入方式，见下表 |
| `enabled` | | `false` 则这条腿不启用 |

`kind` 目前支持：

| `kind` | 用于 | 专有字段 |
|---|---|---|
| `acp` | WorkBuddy 这类 ACP over HTTP + SSE | `autoDiscover: true`（端口动态发现）或 `base: "http://127.0.0.1:xxxx"` |
| `codex-app-server` | Codex（WebSocket + JSON-RPC） | `port`（默认 8899）、`proxy`（一般留空，走全局代理设置） |
| `openai-compatible` | **预留**：任何 OpenAI 兼容的 HTTP 端点 | — |

### 例子：再加一条腿

```json
{
  "agents": [
    { "id": "workbuddy", "name": "WorkBuddy", "color": "#79c0ff",
      "kind": "acp", "autoDiscover": true },
    { "id": "codex", "name": "Codex", "color": "#ffa657",
      "kind": "codex-app-server", "port": 8899 }
  ]
}
```

### 想接一个完全不同的 agent？

现在这份代码就是**两个参考实现**：`app/workbuddy-link.js`（HTTP + SSE 那条）和
`app/relay.js`（WebSocket + JSON-RPC 那条）。照着写一个新 `link`，让中继能

- `connect()` / `init()`
- 建会话（带上工作空间 `cwd`）
- `say()` 或 `prompt()` 发一句话
- 把流式正文通过 `delta` 事件抛出来

再在 `relay-server.js` 的 `_makeLink()` 里挂上你的 `kind` 就行。
两条参考实现的对外接口是**对称**的，抄哪条都行。

---

## 常见问题

**Q：双击 exe 没反应 / 一闪而过？**
先看杀毒软件有没有拦截（未签名的 exe 常被误报）。正常的运行日志在 `~/.agent-hub/relay.log`。

**Q：Codex 那条腿一直是 connecting，或者发消息后卡住不出字？**
几乎都是**代理**问题。点「设置」把代理地址填上；中继启动时会做一次 TCP 探测并自动带上代理，
但探测不出来时需要你手填。

**Q：WorkBuddy 那条腿连不上？**
确认 WorkBuddy 正在运行。它的 ACP 端口每次启动都可能变，中继是动态发现的，一般不需要手动指定。

**Q：改了工作空间，输出还是跑到老目录？**
Codex 换工作空间必须新开一个 thread，中继已经处理了；如果还不对，看 `~/.agent-hub/relay.log`。

**Q：exe 100MB 是不是太大了？**
Electron 的宿命。换来的是零运行时依赖、跨平台潜力。README 里明说，免得你下载时惊讶。

---

## 开发

```bash
cd app
npm install
npm start          # 源码运行

# 打包（产出 dist/AgentHub.exe）
npm run pack
```

仓库根目录还有几个手动测试脚本（需先自己把对应的服务跑起来）：

```bash
node test-workbuddy-link.js     # 测 ACP 那条腿
node test-codex-link.js         # 测 Codex 那条腿
node test-relay.js              # 端到端：两条腿各发一句
node debug-acp.js               # 原始报文调试
```

默认工作空间取**当前目录**，可用 `RELAY_CWD=<路径>` 覆盖。

`codex-schema/`（Codex 的协议定义，约 3.9MB）**没有进仓库**，需要的话自己生成：

```bash
codex app-server generate-json-schema --out codex-schema
```

---

## 许可证

**PolyForm Noncommercial License 1.0.0**（见 [LICENSE](LICENSE)）。

一句话说明：

- ✅ **可以**：个人使用、学习、研究、实验、业余爱好，以及慈善 / 教育 / 公共科研 / 政府机构使用
- ❌ **不可以**：拿去做商业产品、拿去卖、在公司里作为商业用途使用 —— 需要**另行取得授权**

需要商业授权请联系：GitHub [@xieronghuan](https://github.com/xieronghuan)

## 免责声明

本项目按「原样」提供，不对可用性、数据安全或由此产生的任何后果作担保。
WorkBuddy、Codex 等名称与商标归各自所有者所有，本项目与它们没有隶属关系。
