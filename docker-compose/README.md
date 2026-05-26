# Roundtable — Docker Compose 部署

最快的部署方式，适合自托管单机场景。

## 使用

```bash
cd docker-compose
cp .env.example .env
$EDITOR .env          # 至少填写 DEEPSEEK_API_KEY / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / SESSION_SECRET
docker compose up -d
docker compose logs -f
```

打开 `PUBLIC_BASE_URL` 即可（默认 http://localhost:3001）。

## 升级

```bash
docker compose pull
docker compose up -d
```

数据存放在 named volume `roundtable_data`，升级镜像不会丢数据。

## 备份

```bash
# 备份
docker run --rm -v roundtable_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/roundtable-$(date +%F).tar.gz -C /data .

# 还原
docker run --rm -v roundtable_data:/data -v "$PWD":/backup alpine \
  sh -c "cd /data && tar xzf /backup/roundtable-YYYY-MM-DD.tar.gz"
```

## 在 Rauthy 中创建 Client

1. 登录 Rauthy 后台 → Clients → Add new client
2. **Client Type**: Confidential
3. **Redirect URI**: `${PUBLIC_BASE_URL}/auth/callback`
4. **Grant Type**: `authorization_code`
5. **PKCE**: 启用，方法 S256
6. 创建后复制 `client_id` / `client_secret` 填入 `.env`

## 反向代理（生产环境）

如果用 Nginx / Caddy / Traefik 套一层 TLS，需要：

- 把 `PUBLIC_BASE_URL` 改成 `https://...`（Cookie 会自动加 Secure）
- 反代要透传 `Host` header，并对 `/api/conversations/*/events` 这条 SSE 路径关闭缓冲：
  ```nginx
  location /api/conversations/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_buffering off;          # SSE 必须
    proxy_read_timeout 24h;
  }
  ```
