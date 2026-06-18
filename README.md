# Trans工具

一个本地工具网站，共用一个密码登录入口，当前包含“在线翻译”和“在线读书”两个独立模块。

在线翻译支持 DeepSeek 服务端代理、谷歌翻译浏览器直连、多引擎对比、历史记录、服务监控、DeepSeek 余额显示和本地缓存。在线读书支持本地书架、TXT/EPUB/PDF 导入、章节阅读、进度保存、字体切换、黑暗模式和 Xiaomi MiMo 听书。

## 功能概览

- 密码登录，不提供注册和用户体系。
- 登录后进入工具入口页，可选择“在线翻译”或“在线读书”。
- 两个功能页面相互独立，只共用登录入口和登录态。
- 页面右下角显示版本号，CSS/JS 自动带文件修改时间版本参数，减少浏览器缓存旧页面的问题。
- Session Cookie 默认有效期为 30 天。

## 运行

```bash
cd ./path_dir
cp .env.example .env
python3 app.py
```

默认地址：

```text
http://127.0.0.1:31000
```

默认端口由 `.env` 中的 `PORT` 控制。

主要入口：

```text
/           工具选择页
/login      登录页
/translate  在线翻译
/reader     在线读书
```

## 目录

```text
./path_dir/.env                    真实运行配置，包含密码和 API Key
./path_dir/.env.example            示例配置，不放真实密钥
./path_dir/config/app_config.json  普通页面配置，不保存真实 API Key
./path_dir/logs/app.log            应用日志
./path_dir/reader_data             书籍、章节缓存、TTS 音频缓存
./path_dir/static/fonts            阅读字体文件和字体许可说明
```

`reader_data/`、`.env`、日志等运行数据已加入 `.gitignore`。

## 环境配置

`.env.example` 中包含完整示例：

```env
PORT=31000
APP_PASSWORD=changeme
SECRET_KEY=replace-with-a-long-random-string
SESSION_COOKIE_SECURE=false

DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=false

MIMO_API_KEY=
MIMO_TTS_BASE_URL=https://api.xiaomimimo.com/v1/chat/completions
MIMO_TTS_MODEL=mimo-v2.5-tts
MIMO_TTS_VOICE=mimo_default
MIMO_TTS_STYLE_PROMPT=适合小说听书，自然清晰地朗读，情绪丰富一点。
ALLOW_CUSTOM_MIMO_BASE_URL=false
TTS_CACHE_LIMIT_MB=800
TTS_CACHE_TTL_DAYS=180
```

说明：

- `.env` 是真实运行配置，可以放真实密码和 API Key。
- `.env.example` 是示例文件，不应放真实密钥。
- 网页配置页提交新 API Key 后，服务端会写入 `.env`；前端只能看到“已配置”，不会拿到真实 Key。
- 如果只通过 HTTPS 域名访问，建议设置 `SESSION_COOKIE_SECURE=true`。
- 如果直接用 `http://服务器IP:31000` 调试，`SESSION_COOKIE_SECURE=true` 会导致浏览器不发送登录 Cookie。

## 在线翻译

支持引擎：

- `DeepSeek`：由服务器代理请求官方 API，保护 API Key。
- `谷歌翻译`：由浏览器直接请求 `translate.googleapis.com`，走用户当前浏览器网络，不占用服务器外网请求。

主要行为：

- 默认源语言为自动检测，默认目标语言为中文。
- 当源语言手动设置为中文，或自动检测为中文时，目标语言自动推荐英语。
- 可同时勾选 DeepSeek 和谷歌翻译。
- 哪个翻译引擎先返回，哪个结果先显示，不等待最慢的引擎。
- 默认展开前两个翻译结果。
- 每个结果卡片支持折叠、展开和一键复制。
- 折叠状态会在当前页面会话中保持，刷新后恢复默认。
- 本地浏览器历史记录默认保留 100 条。

## DeepSeek 配置和安全

默认：

```env
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=false
```

此时配置页中的 DeepSeek `Base URL` 会变灰且不可修改，只允许官方地址：

```text
https://api.deepseek.com
```

这样可以避免浏览器用户把服务器诱导到恶意地址，间接泄露 DeepSeek API Key。

如果确实需要使用自建代理或兼容网关，可以在 `.env` 中开启：

```env
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=true
```

开启后仍会拒绝本机、内网、保留地址等非公网地址。

## DeepSeek 缓存与费用

服务端有一层本地内存缓存：

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

只要这些参数一致，就会命中本地缓存。这个本地缓存比 DeepSeek 官方上下文缓存更直接，因为命中时完全不发 API 请求。

DeepSeek 官方上下文缓存仍会在本地缓存未命中时按官方策略生效。当前请求结构保持稳定，有利于官方缓存复用固定前缀；但翻译场景里主要节省仍来自本地缓存。

## DeepSeek 余额

主界面翻译引擎里会显示 DeepSeek 余额和更新时间：

```text
DeepSeek (¥xx.xx · 02:31)
```

余额查询走后端代理：

```text
GET /api/deepseek/balance
```

前端不会获得 DeepSeek API Key。

刷新策略：

- 后端不主动定时查询。
- 只有打开前端页面时才会请求余额接口。
- 页面切到后台时不主动刷新。
- 页面重新可见时，超过 15 分钟才刷新。
- 后端也有 15 分钟余额缓存。
- 查询失败后 60 秒内不会反复请求 DeepSeek 官方接口。

余额查询使用 DeepSeek 官方 `GET /user/balance`，不是模型推理接口，不产生翻译 token。

## 在线读书

路由：

```text
/reader
```

支持格式：

- TXT
- EPUB
- PDF

导入和解析：

- 导入文件最大 50MB。
- 最多允许 2 本书同时导入解析。
- EPUB 导入时只建立目录和索引，章节按需解析并缓存，降低导入等待和内存占用。
- EPUB 会限制解压后总大小，避免异常文件占用过多资源。
- EPUB 支持读取封面和正文图片。
- TXT 会智能识别章节；书籍管理中可重新解析，TXT 还支持清除目录信息后作为全文阅读。
- PDF 使用当前环境已有的 `pypdf` 提取文本；扫描版 PDF 如果没有文本层，无法直接阅读。
- MOBI/AZW3 暂未启用。

阅读功能：

- 书架按最后打开时间排序。
- 书籍管理按导入时间由新到旧排序。
- 支持编辑书名、删除书籍、重新解析书籍。
- 保存当前章节和句子进度。
- 支持目录跳转、上一章、下一章。
- 支持字体大小、字体切换和黑暗模式。
- 手机端顶部阅读控制区固定，方便长文阅读时切换章节。

内置字体选项包括：

- 系统字体
- 清松手写体
- 思源宋体
- 思源黑体
- 霞鹜文楷
- 宋体
- 黑体
- 楷体
- 衬线

字体文件和许可说明放在：

```text
./path_dir/static/fonts
```

## 听书

当前听书使用 Xiaomi MiMo TTS：

```text
https://mimo.xiaomi.com/mimo-v2-5-tts
```

网页右上角“听书”中可配置：

- 启用或关闭听书
- MiMo API Key
- 接口地址
- 模型
- 音色
- 单句最大字符数
- 风格/音色描述
- 是否启用服务端音频缓存

当前模型：

```text
mimo-v2.5-tts
```

当前内置音色选项：

- MiMo-默认，自动
- 冰糖，中文女声
- 茉莉，中文女声
- 苏打，中文男声
- 白桦，中文男声
- Mia，英语女声
- Chloe，英语女声
- Milo，英语男声
- Dean，英语男声

听书交互：

- 双击正文句子，从该句开始朗读。
- 单击句子只更新高亮，不开始朗读，避免误触。
- 当前朗读句子会实时高亮。
- 可以暂停、停止、切换倍速、快速切换音色。
- 可以设置定时暂停，支持 5、10、15、30、45、60 分钟和自定义分钟数。
- 定时暂停会等当前句读完，并在最后一段做渐弱后暂停。

## 听书缓存

听书有两层缓存：

1. 浏览器内存缓存
2. 服务器磁盘缓存

浏览器内存缓存：

- 只在当前页面会话中存在，刷新网页后释放。
- 最多保留 12 句。
- 最大约 64MB。
- 用于让刚听过、刚预取的句子立即播放。
- 切换章节、切换音色、修改听书配置时会清空，避免旧音色串用。

服务器磁盘缓存：

- 默认目录：`./path_dir/reader_data/tts_cache`
- 默认大小上限：`TTS_CACHE_LIMIT_MB=800`
- 默认有效期：`TTS_CACHE_TTL_DAYS=180`
- 清理策略同时看大小和过期时间。

缓存键包含：

- 文本
- 模型
- 音色
- 音频格式
- 风格/音色描述
- 文本优化选项

因此切换音色不会删除旧缓存；以后切回同一音色、同一文本、同一配置时仍可命中。命中服务器缓存时不会调用 MiMo API，不消耗 token。

听书会按当前句长度动态预取后续句子：当前句较短时多预取几句，当前句较长时少预取，尽量减少句与句之间的卡顿，同时控制并发和资源占用。

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

操作：

- 刷新
- 清空 DeepSeek 本地缓存，带二次确认
- 重启服务，带二次确认

监控刷新频率为 5 秒。只有打开监控弹窗时才会轮询 `/api/status`，关闭后停止刷新。

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

主要记录：

- 登录成功、失败、限速
- 退出
- 配置保存
- DeepSeek 翻译成功/失败
- MiMo TTS 成功/失败和缓存命中状态
- 书籍导入、删除、重命名、重新解析
- 缓存清空
- 服务重启请求
- 余额查询失败
- 跨站写请求拦截

## 安全说明

- 登录密码不会返回前端。
- API Key 保存到 `.env`。
- 浏览器配置页只允许提交新 Key。
- 服务端不会把真实 Key 返回给浏览器。
- 配置页只显示“已配置，留空不修改”。
- `.env` 写入会清洗换行，避免注入额外环境变量。
- Session Cookie 设置了 `HttpOnly` 和 `SameSite=Lax`。
- 可通过 `SESSION_COOKIE_SECURE=true` 强制会话 Cookie 仅在 HTTPS 下发送。
- 登录失败带轻量限速，降低暴力尝试风险。
- 写请求会检查 `Origin` 和 `Referer`，降低 CSRF 风险。
- 响应头包含 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`。
- 监控接口只读取固定 `/proc` 信息和项目目录磁盘占用，不接受浏览器传路径。
- 重启接口不通过 shell 拼接浏览器参数。
- 书籍导入只写入 `reader_data/books/<book_id>`，`book_id` 限制为 32 位十六进制字符串。
- EPUB 图片资源只允许读取书籍 EPUB 内部的图片文件，并限制单图大小。
- EPUB 不执行书内脚本，只提取文本和图片。

如果通过公网访问本工具，建议在 Nginx 上配置 HTTPS。否则浏览器首次提交密码或 API Key 时，请求会经过当前 HTTP 连接，存在明文传输风险。

服务如果以 root 运行，风险会更高。更稳妥的生产做法是使用单独低权限用户运行，并交给 systemd、gunicorn 或类似进程管理器管理。

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

检查端口：

```bash
ss -ltnp 'sport = :31000'
```

## 注意

- 不要把真实 `.env` 提交到公开仓库。
- 不要把 `reader_data/` 提交到公开仓库，里面可能包含私人书籍和 TTS 音频缓存。
- 修改 `.env` 后需要重启服务。
- 修改模板或后端代码后需要重启服务。
- 修改 CSS/JS 后通常刷新页面即可，静态资源 URL 会自动带版本参数。
