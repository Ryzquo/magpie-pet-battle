# 升级宠物对战中继至协议 v3

交替行动、后手复活和 Token 结算要求两端插件与中继同时更新。请安排在当前对局结束后切换，重启会结束内存中的房间。

## 中继与数据库

Docker 镜像包含全部中继文件。运行单实例，保留原有 HTTPS 入口与端口，给容器的 `/data` 挂载同一个持久卷。首次部署示例：

```bash
docker build -t magpie-pet-battle .
docker run -d --name magpie-pet-battle -p 3574:3574 \
  -v petbattle-wallet:/data magpie-pet-battle
```

已有容器请在部署工具中更新镜像并配置上述卷。容器默认把余额和流水写入 `/data/wallet.sqlite`。直接运行时推荐 Node.js 24 LTS，更新 `server.mjs` 以及 `lib/` 下的 `http.mjs`、`hub.mjs`、`rooms.mjs`、`combat.mjs`、`wallet.mjs`、`adventure-rewards.mjs`。例如：

```bash
ARENA_WALLET_DB=/var/lib/pet-battle/wallet.sqlite node server.mjs
```

`ARENA_WALLET_DB` 是中继进程可写的数据库路径。直接运行时默认位于 `XDG_DATA_HOME`（缺省为 `~/.local/share`）下的 `magpie-pet-battle/wallet.sqlite`。停服备份时保留整个数据目录。旧镜像回滚期间须保留该目录，旧版对局不会产生 Token 流水。

## 客户端与路由

反向代理应将 `/health` 和 `/arena/v3/*` 转发到此中继。若原代理按版本过滤路径，也应将旧版路径转发给新版中继，以便显示升级提示。公网入口使用 HTTPS。本机插件为每个中继在用户数据目录的 `magpie-pet-battle/wallets/` 下分别生成凭据。迁移玩家身份时需私下备份该目录并保留文件权限。

## 验收

```bash
curl -fsS https://<你的域名>/health
```

预期 `protocol` 为 `3`，功能列表含 `alternating-turns`、`revival`、`token-wallet` 和 `adventure-cosmetics`。用两份独立的本机身份建房并加入。双方准备后仅先手能行动，出招后两端应显示相同的伤害和新行动席位。双方有效出招后认负，检查各自结算的应计变动、实计变动和余额。重启中继再打第二场，确认余额接续。
