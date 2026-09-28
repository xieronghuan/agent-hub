'use strict';
/**
 * app/agents.js —— 内置的 agent 清单（默认值）
 *
 * ★ 要接新 agent：改这里，**或者在 ~/.agent-hub/config.json 里用 `agents` 字段覆盖**
 *   （后者不用碰源码）。中继与界面都会自动适配。
 *
 * 每条腿的字段：
 *   id      必需，唯一标识（界面、命令、日志都用它）
 *   name    显示名
 *   color   该 agent 的标识色：顶栏圆点 + 消息正文都用它，两边对应
 *   kind    接入方式：
 *             'acp'                —— ACP over HTTP + SSE（WorkBuddy 这类）
 *             'codex-app-server'   —— codex app-server（WebSocket + JSON-RPC）
 *             'openai-compatible'  —— 预留：任何 OpenAI 兼容的 HTTP 端点
 *   enabled 可选，false 则这条腿不启用
 *
 * kind='acp' 专有：
 *   autoDiscover  true 表示端口动态发现（每次启动都可能变，不要写死）
 *   base          或直接指定地址 http://127.0.0.1:xxxx
 *
 * kind='codex-app-server' 专有：
 *   port          监听端口
 *   proxy         启动时带的代理。**默认留空**：
 *                 实际取值顺序 = 环境变量 RELAY_PROXY → config.json 的 proxy → 自动探测本机常见端口。
 *                 （以前这里写死了 127.0.0.1:7897，那是某一台机器的 Clash 端口，不能当默认值。）
 */

module.exports = [
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    color: '#79c0ff',
    kind: 'acp',
    enabled: true,
    autoDiscover: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    color: '#ffa657',
    kind: 'codex-app-server',
    enabled: true,
    port: 8899,
    proxy: '',
  },
];
