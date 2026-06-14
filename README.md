# 翻译工具

一个本地多语言翻译网站，支持密码登录、DeepSeek 服务端代理、谷歌翻译浏览器直连、多引擎结果对比、历史记录、服务监控、DeepSeek 余额显示和轻量缓存。

## 功能概览

- 密码登录，不提供注册和用户体系。
- DeepSeek 通过后端代理调用，API Key 不返回浏览器。
- 谷歌翻译由浏览器直连 `translate.googleapis.com`，不占用服务器外网请求。
- 支持多语言源语言/目标语言选择。
- 默认源语言为自动检测，默认目标语言为中文。
- 中文源语言且未手动选择目标语言时，自动推荐目标语言为英语。
- 可同时勾选 DeepSeek 和谷歌翻译，默认展开前两个结果。
- 翻译结果渐进显示：哪个引擎先返回，哪个结果先显示，不等待最慢的引擎。
- 每个翻译结果支持折叠、展开和一键复制。
- 本页内会保留手动折叠/展开状态，直到刷新网页。
- 本地浏览器历史记录默认保留 100 条。
- DeepSeek 余额显示在主页面引擎名称后，带更新时间。
- 服务监控页可查看应用进程和系统资源，并支持清空缓存、重启服务。
- 页面右下角显示当前版本号，CSS/JS 自动带文件版本参数，减少浏览器缓存导致的旧页面问题。
- PC 端采用固定视口布局，原文和结果区域内部滚动；手机端使用竖向布局和自然页面滚动。

## 运行

```bash
cd ./path_dir
cp .env.example .env
python3 app.py
```

默认地址：

```text
http://127.0.0.1:3214
```

默认端口由 `.env` 中的 `PORT` 控制，当前默认是 `3214`。

## 配置

敏感配置写入 `.env`：

```text
./path_dir/.env
```

常用项：

```env
PORT=3214
APP_PASSWORD=changeme
SECRET_KEY=replace-with-a-long-random-string
SESSION_COOKIE_SECURE=false

DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=false
```

普通配置写入：

```text
./path_dir/config/app_config.json
```

包括：

- DeepSeek 是否启用
- 模型
- 翻译风格
- temperature
- thinking
- reasoning effort
- timeout
- 谷歌翻译是否启用和接口地址

进入网页后点右上角“配置”，可以修改访问密码、DeepSeek 和谷歌翻译配置。

如果只通过 HTTPS 域名访问，建议将：

```env
SESSION_COOKIE_SECURE=true
```

这样浏览器只会在 HTTPS 连接中发送登录会话 Cookie。若直接使用 `http://服务器IP:3214` 调试，则应保持为 `false`，否则登录态可能无法保持。

## DeepSeek Base URL 安全

默认情况下：

```env
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=false
```

此时配置页中的 DeepSeek `Base URL` 会变灰且不可修改，只允许使用官方地址：

```text
https://api.deepseek.com
```

这样可以避免浏览器用户把服务器诱导到恶意地址，间接泄露 DeepSeek API Key。

如果确实需要使用自建代理或兼容网关，需要在服务器 `.env` 中显式开启：

```env
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=true
```

开启后仍会拒绝本机、内网、保留地址等非公网地址。

## 翻译请求走哪里

- `DeepSeek`：服务器代理请求 DeepSeek，保护 API Key。
- `谷歌翻译`：浏览器直接请求谷歌公共接口，走用户当前浏览器网络。

翻译结果会按引擎独立更新。比如谷歌翻译先返回时会先显示谷歌结果，DeepSeek 较慢时稍后再填充 DeepSeek 结果。每个结果卡片右侧有“复制”按钮，只复制当前引擎的翻译文本。

## DeepSeek 缓存与费用

项目包含一层服务端本地内存缓存：

- 缓存上限：100 条
- 超过 12000 字符的翻译结果不缓存
- 单次翻译文本上限：20000 字符
- 命中本地缓存时不请求 DeepSeek API，不消耗 token

缓存键包含：

- 原文
- 源语言
- 目标语言
- 模型
- temperature
- thinking
- reasoning effort
- 翻译风格

如果这些参数一致，就会命中本地缓存。这个本地缓存比 DeepSeek 官方上下文缓存更省，因为命中时完全不发 API 请求。

DeepSeek 官方上下文缓存仍会在未命中本地缓存时按官方策略生效。当前 prompt 结构保持稳定，有利于官方缓存复用固定前缀，但翻译场景里主要节省仍来自本地缓存。

## DeepSeek 余额

主界面翻译引擎里会显示 DeepSeek 余额：

```text
DeepSeek (¥xx.xx · 02:31)
```

余额查询走后端代理：

```text
GET /api/deepseek/balance
```

前端不会获得 DeepSeek API Key。

余额查询策略：

- 后端不主动定时查询。
- 只有打开前端页面时才会请求余额接口。
- 页面切到后台时不主动刷新。
- 页面重新可见时，超过 15 分钟才刷新。
- 后端也有 15 分钟余额缓存。
- 查询失败后 60 秒内不会反复请求 DeepSeek 官方接口。

余额查询使用 DeepSeek 官方 `GET /user/balance`，不是模型推理接口，不产生翻译 token。

## 监控

登录后点右上角“监控”，可以查看：

应用程序：

- 进程 PID
- 运行时间
- CPU 占用率
- 内存占用：占用量和占用率
- DeepSeek 缓存条数

系统：

- CPU 占用率
- 内存占用率和剩余内存
- 系统负载
- 磁盘占用率和剩余磁盘

监控页操作：

- 刷新
- 清空 DeepSeek 本地缓存，带二次确认
- 重启服务，带二次确认

监控刷新频率为 5 秒。只有打开监控弹窗时才会轮询 `/api/status`，关闭监控弹窗后会停止刷新，因此平时不会持续监控后台资源。

## 日志

日志目录：

```text
./path_dir/logs
```

主日志文件：

```text
./path_dir/logs/app.log
```

日志采用滚动写入：

- 单文件约 2MB
- 最多保留 5 个备份

当前记录：

- 登录成功
- 登录失败
- 退出
- 配置保存
- DeepSeek 翻译成功/失败
- 缓存清空
- 服务重启请求
- 余额查询失败

## 安全说明

- API Key 保存到 `.env`。
- 浏览器配置页只允许提交新 Key。
- 服务端不会把真实 Key 返回给浏览器。
- 配置页只显示“已配置，留空不修改”。
- `.env` 写入会清洗换行，避免注入额外环境变量。
- 请求体上限为 256KB。
- Session Cookie 设置了 `HttpOnly` 和 `SameSite=Lax`。
- 可通过 `.env` 的 `SESSION_COOKIE_SECURE=true` 强制会话 Cookie 仅在 HTTPS 下发送。
- 监控接口只读取固定 `/proc` 信息和项目目录磁盘占用，不接受浏览器传路径。
- 重启接口不通过 shell 拼接浏览器参数。
- 静态资源引用使用文件修改时间作为版本参数，例如 `/static/app.js?v=...`，页面右下角也显示由关键文件修改时间生成的版本号。

如果通过公网访问本工具，建议在 Nginx 上配置 HTTPS。否则浏览器首次提交新 Key 或密码时，请求本身仍会经过当前 HTTP 连接。

服务目前可能以 root 运行。更稳妥的生产做法是使用单独低权限用户运行，并交给 systemd 管理。

## 命令行操作

前台运行时关闭：

```bash
Ctrl+C
```

查找进程：

```bash
ps -ef | grep './path_dir/app.py'
```

关闭进程：

```bash
kill <PID>
```

查看日志：

```bash
tail -f ./path_dir/logs/app.log
```
