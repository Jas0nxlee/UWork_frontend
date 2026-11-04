# 手机远控页：构建与部署（pivot 自托管，2026-11-04 起）

企微工作台里打开的手机页（`backend=uwork` 那条链路）**现在完全由 pivot 自托管**，
不再经 aihub 网关转发。产物的两个落点、nginx 位置、以及"改完怎么验"都记在这里。

## 1. 构建

```bash
cd UWork-frontend
ZCODE_BASE_URL=https://pivot.ucas.com.cn:23090 \
VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://pivot.ucas.com.cn:23090/remote/ws \
pnpm --filter @zcode/web exec vite build --base=/remote/v4/

# 发之前必须删 sourcemap（不删是 180MB+，而且等于把源码发出去了）
find packages/web/dist -name '*.map' -delete      # 182MB → 66MB
```

- `ZCODE_BASE_URL` 决定页面里 help/社区与默认 REST 基址；`VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`
  决定 WebSocket 目标——**必须是绝对地址**，两个落点（pivot / aihub）共用同一份产物。
- 页面同源发现后台：`GET /api/auth/wecom/web-config` 回 `{backend:"uwork",tenantId}`，
  页面把 `location.origin` 当 `apiBaseUrl`，所以**不需要在 URL 里带任何参数**。

## 2. 部署（两个落点）

| 落点                | 宿主机路径                                   | 谁在用                                                     |
| ------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| **pivot（主）**     | `/home/services/ucas-proxy/phone/remote/v4/` | 企微工作台入口 `https://pivot.ucas.com.cn:23090/remote/v4` |
| aihub（二维码兜底） | `/etc/aihub/gateway/html/remote/v4/`         | 桌面弹层的二维码页面 `https://aihub.ucas.com.cn/remote/v4` |

```bash
# 打包（注意 macOS 的 ._* 与扩展属性；COPYFILE_DISABLE 关掉 AppleDouble）
cd packages/web && COPYFILE_DISABLE=1 tar -czf /tmp/phone-v4.tgz -C dist .
ssh root@192.168.100.143 'cat > /tmp/phone-v4.tgz' < /tmp/phone-v4.tgz

# pivot：直接解到挂载目录（nginx 以只读方式挂进容器）
ssh root@192.168.100.143 'tar -xzf /tmp/phone-v4.tgz -C /home/services/ucas-proxy/phone/remote/v4 && chmod -R a+rX /home/services/ucas-proxy/phone'

# aihub：原子换目录，留旧目录做回滚
ssh root@192.168.100.143 'set -e; rm -rf /etc/aihub/gateway/html/remote/v4.new;
  mkdir -p /etc/aihub/gateway/html/remote/v4.new; tar -xzf /tmp/phone-v4.tgz -C /etc/aihub/gateway/html/remote/v4.new;
  chmod -R a+rX /etc/aihub/gateway/html/remote/v4.new;
  mv /etc/aihub/gateway/html/remote/v4 /etc/aihub/gateway/html/remote/v4.old;
  mv /etc/aihub/gateway/html/remote/v4.new /etc/aihub/gateway/html/remote/v4; rm -rf /etc/aihub/gateway/html/remote/v4.old'
```

## 3. 服务端接线（pivot nginx，2026-11-04 起）

`/home/services/ucas-proxy/docker-compose.yml`（nginx 服务）：

- 新增只读挂载 `./phone:/usr/share/nginx/html/phone:ro`
- 新增外部网络 `uwork-backend_default`、`uwork-relay_default`（直连两个容器，**不经 aihub 网关**）

`/home/services/ucas-proxy/nginx/nginx.conf`（23080 server 段）：

| 路径                                                                               | 上游                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `= /remote/v4` / `^~ /remote/v4/{assets,material-icons,pdfjs}/` / `^~ /remote/v4/` | 本机静态 `root /usr/share/nginx/html/phone`（三类资源必须显式 `=404`，别落进 SPA fallback）                |
| `= /remote/ws`                                                                     | `http://uwork-relay:8787`（Upgrade 头 + 3600s 超时 + `proxy_buffering off`）                               |
| `^~ /api/client/remote-`、`^~ /api/auth/wecom/`                                    | `http://uwork-backend-backend-1:3000`，**Host 固定 `aihub.ucas.com.cn`**（后台 `TENANT_HOSTS` 只有 aihub） |

外层还有一层 1Panel openresty（`/opt/1panel/www/conf.d/pivot.ucas.com.cn.conf` + `proxy/root.conf`）
把 23090 整体反代到 23080，那份配置天然透传 Upgrade，不用动。

## 4. 改完怎么验（从外网，一条条过）

```bash
# 页面由 pivot 本地那份在服务（放个只有 pivot 有的文件，别只看状态码）
ssh root@… 'echo marker > /home/services/ucas-proxy/phone/remote/v4/__which-copy.txt'
curl -sk https://pivot.ucas.com.cn:23090/remote/v4/__which-copy.txt     # 应回 marker

curl -sk -o /dev/null -w '%{http_code}\n' https://pivot.ucas.com.cn:23090/remote/v4           # 200
curl -sk https://pivot.ucas.com.cn:23090/api/auth/wecom/web-config                            # {"backend":"uwork",...}
curl -sk -o /dev/null -w '%{http_code}\n' https://pivot.ucas.com.cn:23090/api/client/remote-devices  # 匿名 401
curl -sk -X POST -H 'Origin: https://pivot.ucas.com.cn:23090' -H 'content-type: application/json' \
     -d '{}' https://pivot.ucas.com.cn:23090/api/auth/wecom/attempts                          # 201（不是 403）

# WebSocket 必须强制 HTTP/1.1：HTTP/2 下 Connection/Upgrade 头是禁止的，
# 用 h2 打会得到 relay 的 404（{"error":"not-found"}），那是假失败。
curl -sk --http1.1 -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     -H "Origin: https://pivot.ucas.com.cn:23090" https://pivot.ucas.com.cn:23090/remote/ws | head -3   # 101
```

## 5. 两个坑（都已踩过）

1. **改 nginx.conf 别用未加引号的 heredoc**：`$uri`、`$http_upgrade` 会被本地 shell 展开成空，
   `try_files $uri =404;` 变成 `try_files =404;`，nginx 起不来（容器 crash-loop，全站 502）。
   要么 `<<'PY'`，要么把补丁文件 scp/`cat >` 传上去再改。改完先 `nginx -t` 再 `reload`。
2. **内层 nginx 的 `resolver 127.0.0.11 valid=10s` 已在 http 段**：用容器名直连（`uwork-relay`、
   `uwork-backend-backend-1`）在容器重建换 IP 后能自动跟上，别写死 IP。
