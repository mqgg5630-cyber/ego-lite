# ego-lite ↔ 你的笔记本 打通方案

目标：让**云端 agent**（Arena 沙箱里的我）通过 `ego-browser` 操作**你笔记本上的 Chrome/ego lite**，并用一套可复现的任务阶梯证明"打通"到底通到哪一层。

```
Arena 沙箱 (agent)          relay (server.mjs)          你的笔记本 (bridge.mjs)        ego lite
   run-task.mjs  --HTTP-->   /api/run  --WebSocket-->   node bridge.mjs  --spawn-->  ego-browser nodejs
                              (鉴权 + 任务白名单)          (出站长连接，不开端口)        (真 Chromium + 你的登录态)
```

三条硬约束决定了这个形状：

1. **ego-lite 只有 macOS / Windows 版**（Linux 在 roadmap），沙箱是 Linux，装不了浏览器本体 —— 所以浏览器必须跑在你的笔记本上。
2. `ego-browser` 是笔记本上的本地 CLI，云端访问不到 —— 所以由笔记本**主动出站**连到 relay，而不是云端拨入。
3. 执行的不是"任意代码"，而是仓库里 `bridge/tasks/` 的**固定任务**；relay 只能指定任务名和 JSON 参数，不能投递脚本。

> 关于你给的 `arena/62d9d7a7-0fuye` 分支：这个沙箱的 GitHub 令牌对它没有权限（`git ls-remote` 返回 403，网页 404），所以"打通"没有走它，而是在本仓库 `bridge/` 下实现。如果你要把笔记本这一端放进那个仓库，把 `bridge/` 目录整体复制过去即可，两端代码无耦合。

---

## 一、15 分钟打通

### 1) 云端：起 relay

在这个沙箱里（本仓库根目录）：

```bash
bridge/scripts/dev-relay.sh          # 打印并写入 bridge/.state/tokens.env
```

它会生成两个**不同**的令牌：`EGO_BRIDGE_TOKEN`（笔记本用）、`EGO_AGENT_TOKEN`（agent 用）。
relay 起在 `0.0.0.0:8080`，沙箱预览地址形如 `https://8080-<sandboxId>.e2b.app`。浏览器打开它会看到状态页：`Bridge: offline`。

### 2) 笔记本：装 ego lite 并起 bridge

```bash
# 装 ego lite（已有可跳过）
npx skills add citrolabs/ego-lite        # 或者直接下载 https://lite.ego.app/
# 首次打开 app，完成 onboarding：导入 Chrome 数据 + 注册 ego-browser 到 PATH
# 新开一个终端：
ego-browser nodejs -e "console.log('ready')"
```

把仓库拿到笔记本（`git clone` 你这份 fork，或只复制 `bridge/` 目录），然后：

```bash
cd ego-lite
bridge/scripts/laptop-bridge.sh wss://8080-<sandboxId>.e2b.app/bridge <EGO_BRIDGE_TOKEN>
```

看到 `[bridge] connected ... advertises 8 tasks`，云端状态页变成 `Bridge: connected — <你的机器名>`，链路就通了。

> 笔记本和 relay 在同一台机器上调试时：`bridge/scripts/laptop-bridge.sh ws://127.0.0.1:8080/bridge <token>`。

### 3) 云端：跑任务

```bash
source bridge/.state/tokens.env
node bridge/agent/run-all.mjs                          # 全阶梯（会跳过需要参数的层）
node bridge/agent/run-task.mjs --task smoke-ego        # 只跑单层
```

---

## 二、用哪些任务测"打通"（八层阶梯）

打分标准：**每一层只证明一件事**，失败时能直接指认是哪一段断了。`run-all.mjs` 会打印记分板。

| 层 | 任务 | 证明什么 | 需要什么 |
|---|---|---|---|
| **T0** | `smoke-ego` | 笔记本上的 `ego-browser` 能应答、Space 能建/复用、`p1` 能导航、snapshot 有结构 | 装好 ego lite |
| **T1** | `t1-read-logged-in` | **驱动的是你自己的 profile**：能读到登录后才可见的页面（默认 GitHub 通知页） | onboarding 时导入过 Chrome 数据 |
| **T2** | `t2-interact` | 指针/键盘/选择器层真的生效：填写 → 下拉 → 点击 → `waitForSelector` 拿到提交后的 DOM | 无（`data:` URL，离线） |
| **T3** | `t3-search-summarize` | 外部站点可读、结果页结构可解析、能打开首条取正文（模型在云端做判断） | 能出网 |
| **T4** | `t4-multitab` | 3 个 Page 并行；`tabs()`/`adopt()` 能**只读地**看到你自己的标签页而不抢走它 | 无 |
| **T5** | `t5-checkout-flow` | **完整业务闭环**：登录态校验 → 筛选 → 翻页汇总 → 下载 CSV → 解析下载文件（金额对账） | 本地夹具 `bridge/fixtures/orders-server.mjs` |
| **T6** | `t6-local-app` | **只有本地浏览器才有的能力**：Page 里的 `localhost` 就是你的电脑 —— 打开你本机跑着的 dev server / 后台 / Jupyter / Grafana，取结构 + 截图 | 你本机有个在跑的服务 |
| **T7** | `t7-handoff` | 协作与安全：`handOff()` 把控制权交还给你，`takeOverTaskSpace()` 再拿回来 | 你愿意在 ego lite 里点两下 |

T5 的夹具要先在**笔记本**上起（它代表"你公司那套内网后台"）：

```bash
node bridge/fixtures/orders-server.mjs        # http://127.0.0.1:8787
```

然后云端：

```bash
node bridge/agent/run-all.mjs --local http://localhost:3000 \
  --fixture http://localhost:8787 --url https://github.com/notifications
```

### 建议的实跑顺序

1. `smoke-ego` → 不通就别往下走，先把 `EGO_BROWSER_BIN` / PATH 修好。
2. `t1-read-logged-in` → 这一层失败才是 ego-lite 真正的价值缺口：说明 Space 里的 profile 没有你的 cookie，回 ego lite 重做数据导入。
3. `t2` → `t4`（不需要任何外部依赖，纯链路/并发/协作能力）。
4. `t5`（夹具）→ 这是"能替你干活"的分界线。
5. `t6` 换成你真实在跑的本机服务 → 这是"操作我的电脑"的实证。
6. `t7` 走一遍交接 → 确认紧急情况下你能立刻夺回浏览器。

### 真实的"操作我的电脑"怎么测

T6 是通用入口，给它一个你本机真实在跑的东西，例如：

```bash
node bridge/agent/run-task.mjs --task t6-local-app --params '{"url":"http://localhost:8888","screenshot":true}'   # Jupyter
node bridge/agent/run-task.mjs --task t6-local-app --params '{"url":"http://localhost:3000","screenshot":true}'   # 你的 dev server
node bridge/agent/run-task.mjs --task t6-local-app --params '{"url":"http://localhost:8123"}'                      # Home Assistant
```

返回里会有标题、`h1`、可交互元素数量、正文样本和截图 URL（`/shots/t6-local-app.png`），我就能直接"看见"并继续操作。

---

## 三、新增一层任务

`bridge/tasks/<name>.mjs`，头部注释即文档（relay 会读出来当作任务目录）：

```js
// @title: T8 你的场景
// @params: { "url": string }
// @checks: 这层证明什么
//#include task-kit          // 需要 remark()/shot() 时加这一行

const task = await taskSpace("bridge-t8-mine");
const page = task.page("p1");
await page.goto(params.url);
console.log(await page.snapshot());   // 下一轮直接基于这个快照行动
remark("t8 ok");
await task.finish({ keep: [] });
```

任务里可用：ego-browser 的全部 helper（`taskSpace`/`page.*`/`snapshot`/`mouse`/`keyboard`…）、Node 内置模块（`await import("node:fs/promises")`）、`params`、`remark()`、`shot()`。
任务**不能** import 本地模块，所以共享代码走 `//#include task-kit` 由 bridge 拼接。

---

## 四、安全边界（请先读）

- **双令牌**：桥令牌只在笔记本上；agent 令牌只在云端。两者不同，且都用常量时间比较。`EGO_AGENT_TOKEN` 未设置时 `/api/*` 全部 401。
- **任务白名单 + 无代码投递**：relay 只能点名 `bridge/tasks/` 里已存在的任务，并用正则 `^[a-z0-9-]+$` 校验名字；路径穿越（`../etc/passwd`）被拒。
- **截图令牌按 job 发放**：任务上传截图用的是 relay 为这一 job 生成的短期令牌（默认 30 分钟），拿不到 agent 令牌。
- **只出站**：笔记本不监听任何端口，不碰路由器/NAT。
- **人在环**：ego lite 的 Space 与 `handOff()`/`waitForControl()` 保证你能随时接管；`t7-handoff` 就是验证这条的。
- 已知默认值：`EGO_RELAY_ALLOW_LOOPBACK=1` 时，来自 loopback 的 `/api` 调用可免 agent 令牌（本机开发方便）。**公网部署务必设 `EGO_RELAY_ALLOW_LOOPBACK=0`**。
- relay 的 WebSocket 依赖明文 `ws://`/`wss://`，本身不含业务加密；对外请放在 HTTPS/WSS 之后（Arena 预览域已是 HTTPS）。

---

## 五、自测

```bash
node bridge/test/e2e.mjs
```

用一个**假的** ego-browser 跑通 relay + bridge 全链路（32 项检查）：鉴权、错误令牌被拒、任务目录、任务名穿越、非零退出码透传、异步 job、截图上传与回取、伪造截图令牌、以及每个任务文件的语法与文档头。真实浏览器相关的部分需要你的笔记本参与，这就是上面那套阶梯的意义。

---

## 六、目录

```
bridge/
  relay/server.mjs            云端 relay：HTTP API + 内置 RFC6455 WebSocket（零依赖）
  laptop/bridge.mjs           笔记本桥：出站长连接 + 固定任务执行
  agent/run-task.mjs          agent 侧单任务调用
  agent/run-all.mjs           agent 侧全阶梯 + 记分板
  tasks/smoke-ego.mjs         阶梯任务（见上表）
  tasks/_kit.snippet.js       remark()/shot() 等共享片段（//#include task-kit）
  fixtures/orders-server.mjs  T5 的本地业务夹具
  scripts/dev-relay.sh        起 relay（生成令牌）
  scripts/laptop-bridge.sh    笔记本一键起桥（先检查 ego-browser）
  test/e2e.mjs                假浏览器全链路测试
```
