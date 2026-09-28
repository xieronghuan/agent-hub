'use strict';
/**
 * app/i18n.js — every piece of text a user can see.
 *
 * One flat dictionary per language; `t('key', {name: 'x'})` looks up the current
 * language and fills `{name}`-style placeholders.
 *
 * Language is resolved once at startup by pickLang() in main.js:
 *   config.json `uiLang` (zh | en | auto)  →  auto follows the OS locale  →  zh
 *
 * Keys are grouped by area:
 *   ui.*     terminal window chrome
 *   set.*    settings window
 *   boot.*   startup log lines
 *   cmd.*    what the input box answers
 *   ws.*     workspace switches
 *   log.*    the message archive
 *   relay.*  what the relay layer reports
 */

const DICT = {
  zh: {
    /* ---- terminal window ---- */
    'ui.settings': '设置',
    'ui.settingsTitle': '改本机路径 / 代理（存到用户目录，不动源码）',
    'ui.clearHistory': '清空留档',
    'ui.clearHistoryTitle': '清空历史留档 relay.jsonl',
    'ui.targetTitle': '这条消息发给谁',
    'target.everyone': '所有人',
    'target.everyoneTitle': '一条消息同时发给所有接入的 agent',
    'ui.inputPlaceholder': '输入消息，回车发送…',
    'ui.helpHint': '/help 看命令',
    'ui.noBridge': '（未连接到主进程）',
    'ui.clearedCancelled': '已取消清空留档。',
    'ui.clearFailed': '清空留档失败：{msg}',
    'ui.userLabel': '我',
    'ui.wsTitle': '{name} 的工作空间',
    'ui.dotTitle': '{name}：{status}',

    /* ---- settings window ---- */
    'set.title': '设置',
    'set.storedAt': '存到：',
    'set.scopeNote': '只影响这台电脑，不写进源码',
    'set.nodeLabel': 'node.exe 路径（留空 = 自动探测）',
    'set.codexLabel': 'codex.exe 路径（留空 = 自动探测）',
    'set.proxyLabel': '代理地址（留空 = 自动探测本机常见端口，再不行就不用代理）',
    'set.proxyPlaceholder': '例如 http://127.0.0.1:7897',
    'set.hostPortLabel': 'Codex 端口',
    'set.hostPortHint': 'Agent Hub 会用它在本机起 codex app-server。一般不用改。',
    'set.langLabel': '界面语言（改完要重启）',
    'set.langAuto': '自动（跟随系统）',
    'set.choose': '选择…',
    'set.save': '保存',
    'set.saveRestart': '保存并重启',
    'set.autoFill': '自动检测并填入',
    'set.close': '关闭',
    'set.inUse': '当前生效：{path}',
    'set.autoFound': '自动探测到：{path}',
    'set.notFoundNode': '<b>没找到</b>　请点「选择…」指定，或点「自动检测并填入」',
    'set.notFoundCodex': '<b>没找到</b>　没装 Codex 可以不管；要用就点「选择…」指定',
    'set.proxyFromEnv': '当前来自环境变量 RELAY_PROXY：{path}（会覆盖这里填的）',
    'set.proxyNow': '当前生效：{path}（来自：{src}）',
    'set.proxyNone': '当前：不使用代理。Codex 连不上时，多半要在这里填本机代理地址。',
    'set.noFileYet': '这台电脑还没有配置文件，第一次保存时会自动生成。',
    'set.picked': '已选好，记得点「保存」。',
    'set.detected': '已填入找到的路径，点「保存」生效。',
    'set.detectedPartial': '{missing} 没自动找到；已填入其余找到的，点「保存」生效。',
    'set.saved': '已保存 → {file}\n重启 Agent Hub 后生效。',
    'set.savedRestarting': '已保存，正在重启…',
    'set.saveFailed': '保存失败：{msg}',

    /* ---- startup log ---- */
    'boot.title': '=== Agent Hub 启动 ===',
    'boot.configFile': '设置文件：{file}{suffix}',
    'boot.configMissing': '（还没有，用到时自动生成）',
    'boot.node': 'node = {path}',
    'boot.nodeMissing': '(没找到 —— 可在「设置」里指定)',
    'boot.proxySet': '代理 = {proxy}（来自：{src}）',
    'boot.proxyNone': '代理 = 不使用（Codex 若连不上，多半是这里要填，点右上角「设置」）',
    'boot.wsFound': '发现 {n} 个工作空间，默认：{path}',
    'boot.noCodexCli': '★ 没找到 Codex CLI —— 已打开「设置」窗口，选一下 codex.exe 的位置即可。',
    'boot.legSkipped': '{name} 跳过：没有 Codex CLI 路径',
    'boot.portBusy': '{name} 端口 {port} 已被占用，先清掉上次留下的残留进程…',
    'boot.startingServer': '启动 {name} 的 app-server…',
    'boot.serverReady': '{name} app-server 就绪（:{port}）',
    'boot.serverTimeout': '{name} app-server 30 秒内未监听 {port}',
    'boot.discoverAcp': '发现 ACP 端口…',
    'boot.portsFound': '发现端口：{list}',
    'boot.noAcpPort': '没发现可用的 ACP 端口',
    'boot.startingRelay': '启动对等中继…',
    'boot.status': '各 agent 状态：{json}',
    'boot.ready': '底栏选「发给谁」+ 输入回车即可。',
    'boot.relayFailed': '中继启动失败：{msg}',

    'proxy.srcEnv': '环境变量 RELAY_PROXY',
    'proxy.srcConfig': '配置文件',
    'proxy.srcAuto': '自动探测',
    'proxy.srcNone': '无（未使用代理）',

    'status.starting': '启动中…',
    'status.connected': '{ready}/{total} 已连接',
    'status.relayFailed': '中继失败',
    'turn.done': '{name} 本轮结束',

    'proc.exited': '{tag} 退出 code={code}',
    'proc.cleanup': '兜底清理监听进程 pid={pid}',

    /* ---- input box ---- */
    'help.intro': '用法：底栏选「发给谁」+ 输入回车即可。以下是可选命令：',
    'help.ws': '  /ws            列出工作空间',
    'help.wsSwitch': '  /ws <编号|路径> 切换当前默认目标的工作空间',
    'help.target': '  /t <agentId>   切换底栏默认目标',
    'help.everyone': '  底栏目标选「所有人」：一条消息同时发给全部 agent',
    'help.auto': '  自动接力默认开着：谁答完，回复就转给另一个（/stop 停这一轮）',
    'help.stop': '  /stop          停掉这一轮的自动接力',
    'help.status': '  /status        看各 agent 状态',
    'help.clear': '  /clear         清屏',
    'help.help': '  /help          看这条',
    'help.buttons': '界面右上角的「{settings}」「{clear}」是按钮，点就行。',
    'cmd.workspaces': '工作空间：{json}',
    'cmd.workspaceList': '工作空间：',
    'cmd.pathMissing': '路径不存在：{path}',
    'cmd.targetSet': '默认目标 → {id}',
    'cmd.targetOptions': '可选：{list}',
    'cmd.relayNotReady': '中继未就绪，发不出去。看上面的启动日志。',
    'cmd.sentTo': '→ {names}',
    'cmd.sendFailedTo': '发给 {name} 失败：{msg}',
    'cmd.switchFailed': '切换失败：{msg}',
    'ws.switched': '{id} 工作空间 → {path}',

    /* ---- message archive ---- */
    'log.clearTitle': '确定清空留档吗？',
    'log.clearDetail': '将清空 {file} 中现有的 {n} 条记录，清空后不可恢复。\n（relay.log 运行日志不受影响）',
    'log.clearCancel': '取消',
    'log.clearOk': '清空',
    'log.clearFailed': '清空留档失败：{msg}',
    'log.cleared': '留档已清空（原有 {n} 条）→ {file}',

    /* ---- settings IPC ---- */
    'set.savedLog': '设置已保存 → {file}（重启 Agent Hub 后生效）',
    'set.saveFailedLog': '设置保存失败：{msg}',
    'set.pickNode': '选择 node.exe',
    'set.pickCodex': '选择 codex.exe',
    'set.restarting': '按用户要求重启 Agent Hub…',
    'win.settingsTitle': 'Agent Hub · 设置',

    /* ---- relay layer ---- */
    'relay.started': '中继启动，接了 {n} 个 agent：{names}',
    'relay.readyServer': '{name} 就绪（thread={thread}  cwd={cwd}）',
    'relay.readyAcp': '{name} 就绪（{base}  session={session}  cwd={cwd}）',
    'relay.borrowed': '{name} 接入了客户端已有的会话：{session}',
    'relay.borrowFailed': '借用会话 {session} 失败（{msg}），改用新建',
    'relay.acpPick': 'ACP 入口 :{port}（它的会话目录：{cwd}）',
    'relay.acpUnknownCwd': '未知',
    'relay.acpTempWarn': '⚠️ 这个入口的工作目录是临时目录 —— agent 在里面干活会找不到你的文件。换个入口，或先在 WorkBuddy 客户端里打开目标目录。',
    'relay.failed': '{name} 接入失败：{msg}',
    'relay.noAcp': '没发现可用的 ACP 端口',
    'relay.unsupportedKind': '暂不支持的 kind：{kind}',
    'relay.notReadyWsOnly': '{name} 未就绪，仅记录工作空间',
    'relay.switchedThread': '{name} 已切到 {cwd}（thread={thread}）',
    'relay.switchedSession': '{name} 已切到 {cwd}（session={session}）',
    'relay.emptyText': '内容为空',
    'relay.unknownAgent': '未知 agent：{id}',
    'relay.notReady': '{name} 未就绪',
    'relay.mark': '[中继·{name}] ',
    'relay.fromAgent': '[中继·来自 {name}] ',
    'relay.desk': '[中继] 这张桌子上还接入了：{others}。你看不到它们，也不能直接联系它们 —— 消息都经过中继转达。',
    'relay.autoArmed': '自动接力：谁答完，它的回复会自动转给另一个 agent（最多 {n} 轮）。输入 /stop 停这一轮。',
    'relay.autoArmedNoLimit': '自动接力：谁答完，它的回复会自动转给另一个 agent（不限轮数，输入 /stop 停）。',
    'relay.autoForward': '{from} 的回复转给了 {to}（第 {n}/{max} 轮）',
    'relay.autoForwardFailed': '转给 {to} 失败：{msg}',
    'relay.autoStopped': '自动接力已停（到上限 {n} 轮）。要接着聊就再发一条。',
    'relay.autoOff': '自动接力已停。',
  },

  en: {
    /* ---- terminal window ---- */
    'ui.settings': 'Settings',
    'ui.settingsTitle': 'Machine-specific paths and proxy (stored in your user folder, not in the source)',
    'ui.clearHistory': 'Clear history',
    'ui.clearHistoryTitle': 'Clear the message archive (relay.jsonl)',
    'ui.targetTitle': 'Who this message goes to',
    'target.everyone': 'Everyone',
    'target.everyoneTitle': 'Send one message to every connected agent',
    'ui.inputPlaceholder': 'Type a message, press Enter…',
    'ui.helpHint': '/help for commands',
    'ui.noBridge': '(not connected to the main process)',
    'ui.clearedCancelled': 'Clear cancelled.',
    'ui.clearFailed': 'Could not clear the archive: {msg}',
    'ui.userLabel': 'you',
    'ui.wsTitle': '{name} workspace',
    'ui.dotTitle': '{name}: {status}',

    /* ---- settings window ---- */
    'set.title': 'Settings',
    'set.storedAt': 'Saved to:',
    'set.scopeNote': 'this machine only, nothing is written into the source',
    'set.nodeLabel': 'node.exe path (empty = auto-detect)',
    'set.codexLabel': 'codex.exe path (empty = auto-detect)',
    'set.proxyLabel': 'Proxy (empty = probe common local ports, otherwise no proxy)',
    'set.proxyPlaceholder': 'e.g. http://127.0.0.1:7897',
    'set.hostPortLabel': 'Codex port',
    'set.hostPortHint': 'Agent Hub starts the codex app-server on this port. You normally never need to change it.',
    'set.langLabel': 'Interface language (restart to apply)',
    'set.langAuto': 'Auto (follow the system)',
    'set.choose': 'Choose…',
    'set.save': 'Save',
    'set.saveRestart': 'Save & restart',
    'set.autoFill': 'Detect and fill in',
    'set.close': 'Close',
    'set.inUse': 'In use now: {path}',
    'set.autoFound': 'Auto-detected: {path}',
    'set.notFoundNode': '<b>Not found</b> — click Choose…, or Detect and fill in',
    'set.notFoundCodex': '<b>Not found</b> — ignore this if you do not use Codex; otherwise click Choose…',
    'set.proxyFromEnv': 'Currently from the RELAY_PROXY env var: {path} (overrides this field)',
    'set.proxyNow': 'In use now: {path} (from: {src})',
    'set.proxyNone': 'Right now: no proxy. If Codex cannot connect, this is usually where the local proxy goes.',
    'set.noFileYet': 'No config file on this machine yet; it is created the first time you save.',
    'set.picked': 'Picked. Do not forget to hit Save.',
    'set.detected': 'Filled in what was found. Hit Save to apply.',
    'set.detectedPartial': '{missing} not found automatically; the rest was filled in. Hit Save to apply.',
    'set.saved': 'Saved → {file}\nRestart Agent Hub to apply.',
    'set.savedRestarting': 'Saved. Restarting…',
    'set.saveFailed': 'Could not save: {msg}',

    /* ---- startup log ---- */
    'boot.title': '=== Agent Hub starting ===',
    'boot.configFile': 'Config file: {file}{suffix}',
    'boot.configMissing': ' (not created yet — it appears the first time something needs saving)',
    'boot.node': 'node = {path}',
    'boot.nodeMissing': '(not found — you can set it in Settings)',
    'boot.proxySet': 'Proxy = {proxy} (from: {src})',
    'boot.proxyNone': 'Proxy = none (if Codex cannot connect, this is usually why — open Settings in the top right)',
    'boot.wsFound': 'Found {n} workspaces, default: {path}',
    'boot.noCodexCli': '★ Codex CLI not found — the Settings window is open; pick your codex.exe there.',
    'boot.legSkipped': '{name} skipped: no Codex CLI path',
    'boot.portBusy': '{name} port {port} is still in use — clearing the process left over from last time…',
    'boot.startingServer': 'Starting the {name} app-server…',
    'boot.serverReady': '{name} app-server ready (:{port})',
    'boot.serverTimeout': '{name} app-server did not listen on {port} within 30s',
    'boot.discoverAcp': 'Looking for ACP ports…',
    'boot.portsFound': 'Ports found: {list}',
    'boot.noAcpPort': 'No usable ACP port found',
    'boot.startingRelay': 'Starting the relay…',
    'boot.status': 'Agent status: {json}',
    'boot.ready': 'Pick a target in the bottom bar, type, and press Enter.',
    'boot.relayFailed': 'Relay failed to start: {msg}',

    'proxy.srcEnv': 'the RELAY_PROXY env var',
    'proxy.srcConfig': 'the config file',
    'proxy.srcAuto': 'auto-detected',
    'proxy.srcNone': 'none',

    'status.starting': 'Starting…',
    'status.connected': '{ready}/{total} connected',
    'status.relayFailed': 'Relay failed',
    'turn.done': '{name} finished its turn',

    'proc.exited': '{tag} exited with code={code}',
    'proc.cleanup': 'Cleaning up leftover listener, pid={pid}',

    /* ---- input box ---- */
    'help.intro': 'Pick a target in the bottom bar, type, press Enter. Optional commands:',
    'help.ws': '  /ws            list workspaces',
    'help.wsSwitch': '  /ws <n|path>   switch the current target to another workspace',
    'help.target': '  /t <agentId>   change the default target',
    'help.everyone': '  Pick "Everyone" in the bottom bar to send one message to all agents',
    'help.auto': '  Auto-relay is on by default: whoever answers, its reply goes to the other (/stop ends the round)',
    'help.stop': '  /stop          stop this round of auto-relay',
    'help.status': '  /status        show agent status',
    'help.clear': '  /clear         clear the screen',
    'help.help': '  /help          show this',
    'help.buttons': 'The {settings} and {clear} buttons in the top right work too.',
    'cmd.workspaces': 'Workspaces: {json}',
    'cmd.workspaceList': 'Workspaces:',
    'cmd.pathMissing': 'No such path: {path}',
    'cmd.targetSet': 'Default target → {id}',
    'cmd.targetOptions': 'Available: {list}',
    'cmd.relayNotReady': 'The relay is not ready, nothing was sent. Check the startup log above.',
    'cmd.sentTo': '→ {names}',
    'cmd.sendFailedTo': 'Failed to send to {name}: {msg}',
    'cmd.switchFailed': 'Switch failed: {msg}',
    'ws.switched': '{id} workspace → {path}',

    /* ---- message archive ---- */
    'log.clearTitle': 'Clear the message archive?',
    'log.clearDetail': 'This deletes the {n} entries currently in {file}. It cannot be undone.\n(relay.log is not affected)',
    'log.clearCancel': 'Cancel',
    'log.clearOk': 'Clear',
    'log.clearFailed': 'Could not clear the archive: {msg}',
    'log.cleared': 'Archive cleared ({n} entries removed) → {file}',

    /* ---- settings IPC ---- */
    'set.savedLog': 'Settings saved → {file} (restart Agent Hub to apply)',
    'set.saveFailedLog': 'Could not save settings: {msg}',
    'set.pickNode': 'Choose node.exe',
    'set.pickCodex': 'Choose codex.exe',
    'set.restarting': 'Restarting Agent Hub as requested…',
    'win.settingsTitle': 'Agent Hub · Settings',

    /* ---- relay layer ---- */
    'relay.started': 'Relay started with {n} agents: {names}',
    'relay.readyServer': '{name} ready (thread={thread}  cwd={cwd})',
    'relay.readyAcp': '{name} ready ({base}  session={session}  cwd={cwd})',
    'relay.borrowed': '{name} attached to the session the client already shows: {session}',
    'relay.borrowFailed': 'Could not attach to session {session} ({msg}); opening a new one instead',
    'relay.acpPick': 'ACP endpoint :{port} (its session folder: {cwd})',
    'relay.acpUnknownCwd': 'unknown',
    'relay.acpTempWarn': '⚠️ This endpoint works in a temp folder — the agent will not find your files there. Use another endpoint, or open the target folder in the WorkBuddy client first.',
    'relay.failed': '{name} failed to connect: {msg}',
    'relay.noAcp': 'No usable ACP port found',
    'relay.unsupportedKind': 'Unsupported kind: {kind}',
    'relay.notReadyWsOnly': '{name} is not ready — workspace recorded only',
    'relay.switchedThread': '{name} switched to {cwd} (thread={thread})',
    'relay.switchedSession': '{name} switched to {cwd} (session={session})',
    'relay.emptyText': 'Message is empty',
    'relay.unknownAgent': 'Unknown agent: {id}',
    'relay.notReady': '{name} is not ready',
    'relay.mark': '[Agent Hub · {name}] ',
    'relay.fromAgent': '[Agent Hub · from {name}] ',
    'relay.desk': '[Agent Hub] Also connected to this hub: {others}. You cannot see or reach them directly — messages travel through the hub.',
    'relay.autoArmed': 'Auto-relay: whichever agent answers, its reply is passed to the other (up to {n} rounds). Type /stop to stop this round.',
    'relay.autoArmedNoLimit': 'Auto-relay: whichever agent answers, its reply is passed to the other (no round limit — type /stop to stop).',
    'relay.autoForward': 'Forwarded {from}\'s reply to {to} (round {n}/{max})',
    'relay.autoForwardFailed': 'Could not forward to {to}: {msg}',
    'relay.autoStopped': 'Auto-relay stopped after {n} rounds. Send another message to continue.',
    'relay.autoOff': 'Auto-relay stopped.',
  },
};

let lang = 'zh';

/** @param {'zh'|'en'} l */
function setLang(l) {
  lang = DICT[l] ? l : 'zh';
}

function getLang() {
  return lang;
}

/**
 * Look a key up in the current language. Missing keys fall back to Chinese,
 * then to the key itself, so a typo shows up as the raw key instead of "undefined".
 */
function t(key, vars) {
  const d = DICT[lang] || DICT.zh;
  let s = d[key];
  if (s === undefined) s = DICT.zh[key];
  if (s === undefined) s = key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}

module.exports = { setLang, getLang, t, DICT };
