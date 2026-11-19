# 升级宠物对战中继

给运行中继服务的一方：这是一次服务端更新，玩家不需要做任何操作。

## 这次改了什么

中继是双方对战房间的服务器，负责房间、配装锁定和每回合伤害结算。本次更新让中继读取玩家当前出战形态的图鉴力量和闪避，并据此分配等总点数的基础属性。

旧版中继会忽略客户端上报的 `combatStats` 字段，继续按物种分配基础属性。**不升级也能正常对战**，只是双方看不到彼此的图鉴数值，属性仍按旧规则计算。

## 需要的文件

从仓库取新版本后，中继只依赖以下文件：

- `server.mjs`
- `lib/http.mjs`、`lib/hub.mjs`、`lib/rooms.mjs`、`lib/combat.mjs`

`Dockerfile` 已包含这些文件，直接重建镜像即可。

## 升级步骤

用 Docker 部署时，在仓库目录重新构建并重启容器，保留原有环境变量和端口映射：

```bash
git pull
docker build -t magpie-pet-battle .
docker rm -f magpie-pet-battle
docker run -d --name magpie-pet-battle -p 3574:3574 \
  -e ARENA_HOST=0.0.0.0 -e ARENA_PORT=3574 magpie-pet-battle
```

用 Node 直接运行时，覆盖上述文件后重启进程即可，`ARENA_HOST`、`ARENA_PORT` 的用法不变。

## 验证

先看健康检查，`features` 里应出现 `combat-stats`：

```bash
curl -sS https://<你的域名>/health
# {"ok":true,"protocol":2,"features":["combat-stats"]}
```

再确认房间确实接收了图鉴数值。把下面命令返回的 `players[0]` 与旧行为对比，`pet.combatStats` 应保留，`base` 应与力量、闪避对应：

```bash
curl -sS -X POST https://<你的域名>/arena/v2/room \
  -H 'content-type: application/json' \
  -d '{"action":"create","pet":{"name":"probe","species":"probe","speciesId":"1-001","stage":1,"combatStats":{"strength":90,"evasion":10}}}'
```

预期 `base` 为 `{"attack":6,"defense":2,"vitality":4}`，`profile` 为「强攻型」。若 `combatStats` 消失或 `base` 仍是 `{"attack":3,"defense":3,"vitality":6}`，说明仍在运行旧版。

## 影响与回滚

- 房间保存在进程内存中，重启会结束当时正在进行的对局，其余数据不受影响，无需迁移。
- 旧版客户端连新版中继、新版客户端连旧版中继都能正常打完，缺少图鉴数值时回落到按物种分配。
- 需要回滚时换回原镜像即可，中继不写入任何持久化状态。
