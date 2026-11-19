# Magpie 宠物对战

独立安装的 Magpie 插件，使用 `magpie-digital-pet` v0.6.0 中当前出战的宠物，提供中文大厅和双人回合制对战。宠物存档以只读方式打开。

## 安装

开发预览版可通过 GitHub 安装。双方分别在自己的电脑上运行 `magpie plugin add github:Ryzquo/magpie-pet-battle`。也可将本目录复制到各自的电脑后本地安装。

```bash
cd /path/to/magpie-pet-battle
magpie plugin add "$PWD"
```

安装后刷新 Magpie，在左侧「插件」下进入「宠物对战」。确认原「宠物」页已选定出战宠物。插件页面使用 `127.0.0.1:3572`。请在运行对应 Magpie 插件宿主的电脑上打开页面。若已有安装记录但侧栏入口未出现，可在「插件 → 已安装」将「宠物对战」停用后再启用，重新加载插件。若原插件修改过存档位置，在对战插件的选项中将 `petDbPath` 设为同一数据库的绝对路径。配置修改未立即生效时，重启对应的 Magpie 实例。

## 局域网对战

双方进入大厅并开启「局域网发现」。一方在附近玩家列表点击「挑战」，另一方接受，双方准备后开始。挑战发起方的 Magpie 负责本局结算。发现使用 IPv4 组播 `239.255.77.82:35733/UDP`，对局连接使用房主和受邀方插件打开的 TCP 端口。受访客 Wi-Fi 隔离或系统防火墙影响时，可改用对战码。

## 对战码

双方的 `relayUrl` 须指向同一个房间服务。房间服务独立运行，使用 Node.js 22 或更新版本，无需安装 npm 依赖。

```bash
cd /path/to/magpie-pet-battle
node server.mjs
```

云平台可使用仓库根目录的 `Dockerfile` 部署单个常驻实例，配置平台提供的 HTTPS 入口和健康检查路径 `/health`。容器监听 `0.0.0.0`，依次读取 `ARENA_PORT`、平台的 `PORT`，默认端口为 `3574`。房间保存在该实例的内存中，实例重启会结束当前对局。

直接用 Node 启动时默认监听 `127.0.0.1:3574`，`GET /health` 可检查运行状态。局域网自用可通过 `ARENA_HOST` 绑定服务器的局域网地址，`ARENA_PORT` 可调整端口。异地对战可在该服务前配置 HTTPS 反向代理，将 `/health` 和 `/arena/v1/room` 转发到服务，然后在两边填写 HTTPS 地址。以下以已部署 HTTPS 服务为例。

```bash
magpie plugin options magpie-pet-battle '{"relayUrl":"https://battle.example.com"}'
```

已有 `petDbPath` 时，在同一个 JSON 中保留它。一方点击「创建房间」并发送 8 位对战码，另一方输入后加入。房间在内存中保存，房主或房间服务重启后需要重新建房。

## 对战规则

每只宠物有 3 点生命。每回合有 45 秒选招，双方选定后一起公开。猛攻克制聚力，聚力克制防守，防守克制猛攻。超时的一方输掉该回合，双方都超时则平手。先把对手生命降到 0 的一方获胜，打满 9 回合按剩余生命判定。宠物的进化阶段用于展示。短时网络中断或页面刷新后，同一插件进程仍可恢复房间。

## 验证

```bash
node --test tests/*.test.mjs
```

版本变化见 [VERSION](VERSION)。
