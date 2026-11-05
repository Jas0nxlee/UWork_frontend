# 手机远控页：自托管构建与部署示例

企微工作台的手机页（`backend=uwork`）可由企业控制面自托管，并由网关提供二维码备用入口。下列域名、主机和路径均为占位示例，部署时替换为自己的配置；本文不表示这些服务已经部署或通过真机验收。

## 1. 构建

```bash
cd /path/to/UWork_frontend
ZCODE_BASE_URL=https://control-plane.example.com:9443 \
VITE_ZCODE_WEB_REMOTE_CONTROL_VERSION_GUARD=off \
VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://control-plane.example.com:9443/remote/ws \
pnpm --filter @zcode/web exec vite build --base=/remote/v4/

# 部署不需要源映射时，发布静态目录前可移除它们
find packages/web/dist -name '*.map' -delete
```

- 示例明确关闭版本导航，仅适用于单一静态构建。按桌面版本分发不同资源的部署应省略该开关，继续默认版本校验。历史导航记录不能证明当前页面加载的资源版本。
- `ZCODE_BASE_URL` 决定页面里 help/社区与默认 REST 基址；`VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`
  决定 WebSocket 目标——**必须是绝对地址**，两个示例落点（控制面 / 网关）共用同一份产物。
- 页面同源发现后台：`GET /api/auth/wecom/web-config` 回 `{backend:"uwork",tenantId}`，
  页面把 `location.origin` 当 `apiBaseUrl`，所以**不需要在 URL 里带任何参数**。

## 2. 部署（两个示例落点）

| 落点                | 宿主机路径                                   | 谁在用                                                     |
| ------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| **控制面（主）**     | `/srv/uwork-control-plane/phone/remote/v4/` | 企微工作台入口 `https://control-plane.example.com:9443/remote/v4` |
| 网关（二维码备用） | `/srv/uwork-gateway/html/remote/v4/`         | 桌面弹层的二维码页面 `https://gateway.example.com/remote/v4` |

```bash
# 打包（注意 macOS 的 ._* 与扩展属性；COPYFILE_DISABLE 关掉 AppleDouble）
cd packages/web && COPYFILE_DISABLE=1 tar -czf /tmp/phone-v4.tgz -C dist .
ssh root@deploy.example.com 'cat > /tmp/phone-v4.tgz' < /tmp/phone-v4.tgz

# 控制面：直接解到挂载目录（nginx 以只读方式挂进容器）
ssh root@deploy.example.com 'tar -xzf /tmp/phone-v4.tgz -C /srv/uwork-control-plane/phone/remote/v4 && chmod -R a+rX /srv/uwork-control-plane/phone'

# 网关：原子换目录，留旧目录做回滚
ssh root@deploy.example.com 'set -e; rm -rf /srv/uwork-gateway/html/remote/v4.new;
  mkdir -p /srv/uwork-gateway/html/remote/v4.new; tar -xzf /tmp/phone-v4.tgz -C /srv/uwork-gateway/html/remote/v4.new;
  chmod -R a+rX /srv/uwork-gateway/html/remote/v4.new;
  mv /srv/uwork-gateway/html/remote/v4 /srv/uwork-gateway/html/remote/v4.old;
  mv /srv/uwork-gateway/html/remote/v4.new /srv/uwork-gateway/html/remote/v4; rm -rf /srv/uwork-gateway/html/remote/v4.old'
```

## 3. 服务端接线示例

`/srv/uwork-control-plane/docker-compose.yml`（nginx 服务）：

- 新增只读挂载 `./phone:/usr/share/nginx/html/phone:ro`
- 新增外部网络 `uwork-backend_default`、`uwork-relay_default`（直连两个容器，**不经外层网关**）

`/srv/uwork-control-plane/nginx/nginx.conf`（8080 server 段）：

| 路径                                                                               | 上游                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `= /remote/v4` / `^~ /remote/v4/{assets,material-icons,pdfjs}/` / `^~ /remote/v4/` | 本机静态 `root /usr/share/nginx/html/phone`（三类资源必须显式 `=404`，别落进 SPA fallback）                |
| `= /remote/ws`                                                                     | `http://uwork-relay:8787`（Upgrade 头 + 3600s 超时 + `proxy_buffering off`）                               |
| `^~ /api/client/remote-`、`^~ /api/auth/wecom/`                                    | `http://uwork-backend-backend-1:3000`，**Host 固定 `gateway.example.com`**（应与后台 `TENANT_HOSTS` 配置一致） |

如果外层还有一层反向代理（`/etc/nginx/conf.d/control-plane.conf` + `proxy/root.conf`）
将 9443 转发到 8080，也必须检查其 Upgrade 头透传。

## 4. 改完怎么验（从外网，一条条过）

```bash
# 确认页面由控制面的本地静态目录提供（用临时标记区分，不只看状态码）
ssh root@… 'echo marker > /srv/uwork-control-plane/phone/remote/v4/__which-copy.txt'
curl -sS https://control-plane.example.com:9443/remote/v4/__which-copy.txt     # 应回 marker

curl -sS -o /dev/null -w '%{http_code}\n' https://control-plane.example.com:9443/remote/v4           # 200
curl -sS https://control-plane.example.com:9443/api/auth/wecom/web-config                            # {"backend":"uwork",...}
curl -sS -o /dev/null -w '%{http_code}\n' https://control-plane.example.com:9443/api/client/remote-devices  # 匿名 401
curl -sS -X POST -H 'Origin: https://control-plane.example.com:9443' -H 'content-type: application/json' \
     -d '{}' https://control-plane.example.com:9443/api/auth/wecom/attempts                          # 201（不是 403）

# WebSocket 必须强制 HTTP/1.1：HTTP/2 下 Connection/Upgrade 头是禁止的，
# 用 h2 打会得到 relay 的 404（{"error":"not-found"}），那是假失败。
curl -sS --http1.1 -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     -H "Origin: https://control-plane.example.com:9443" https://control-plane.example.com:9443/remote/ws | head -3   # 101
```

## 5. 配置注意事项

1. **改 nginx.conf 别用未加引号的 heredoc**：`$uri`、`$http_upgrade` 会被本地 shell 展开成空，
   `try_files $uri =404;` 变成 `try_files =404;`，nginx 起不来（容器 crash-loop，全站 502）。
   要么 `<<'PY'`，要么把补丁文件 scp/`cat >` 传上去再改。改完先 `nginx -t` 再 `reload`。
2. **容器名解析应随部署验收**：Docker 内可配置 `resolver 127.0.0.11 valid=10s`，但静态 `proxy_pass` 仅设置 resolver 并不保证在容器换 IP 后重解析；应按实际 nginx 版本与 upstream/变量写法配置，并验证容器重建后的连接。
