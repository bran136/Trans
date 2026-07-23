# Trans工具

一个本地工具网站，共用一个密码登录入口，当前包含“在线翻译”和“在线读书”两个独立模块。

在线翻译支持 DeepSeek 服务端代理、谷歌翻译浏览器直连、多引擎对比、历史记录、服务监控、DeepSeek 余额显示和持久化缓存。在线读书支持本地书架、TXT/EPUB/PDF 导入、章节阅读、进度保存、字体切换、黑暗模式和 Xiaomi MiMo 听书。

## 功能概览

- 密码登录，不提供注册和用户体系。
- 登录后进入工具入口页，可选择“在线翻译”或“在线读书”。
- 两个功能页面相互独立，只共用登录入口和登录态。
- 提供站点图标和 Web App Manifest；支持的手机浏览器可将网站安装到桌面，以独立窗口打开。
- 页面右下角显示版本号，CSS/JS 自动带文件修改时间版本参数，减少浏览器缓存旧页面的问题。
- Session Cookie 默认有效期为 30 天。

## 运行

```bash
cd ./path_dir
cp .env.example .env
python3 -m pip install -r requirements.txt
# 先编辑 .env，至少替换 APP_PASSWORD
python3 app.py
```

`requirements.txt` 约束了 Flask、requests、pypdf、urllib3 和 idna 的安全最低版本。已有环境也应重新执行安装命令完成升级，不能只重启旧环境。

默认地址：

```text
http://127.0.0.1:31000
```

默认只监听 `127.0.0.1`，端口由 `.env` 中的 `PORT` 控制。需要从其他机器直接访问时，可以把 `HOST` 改为 `0.0.0.0` 并使用强密码；更推荐继续监听本机，通过 HTTPS 反向代理访问。

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
./path_dir/config/app_config.json  普通页面配置，缺失时自动生成，不保存真实 API Key
./path_dir/config/deepseek_cache.sqlite3  DeepSeek 翻译持久化缓存
./path_dir/config/mimo_balance_state.json  MiMo 余额、过期状态和白名单 Cookie（私有）
./path_dir/logs/app.log            应用日志
./path_dir/reader_data             书籍、章节缓存、TTS 音频缓存
./path_dir/static/fonts            页面字体资产和许可说明
```

`reader_data/`、`.env`、DeepSeek 缓存和日志等运行数据已加入 `.gitignore`。

## 环境配置

`.env.example` 中包含完整示例：

```env
PORT=31000
HOST=127.0.0.1
APP_PASSWORD=replace-with-a-strong-password
SECRET_KEY=
SESSION_COOKIE_SECURE=false
ALLOW_ROOT_RUN=true

DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=false

MIMO_API_KEY=
MIMO_TTS_BASE_URL=https://api.xiaomimimo.com/v1/chat/completions
MIMO_BALANCE_URL=https://platform.xiaomimimo.com/api/v1/balance
MIMO_TTS_MODEL=mimo-v2.5-tts
MIMO_TTS_VOICE=mimo_default
MIMO_TTS_STYLE_PROMPT=适合小说听书，自然清晰地朗读，情绪丰富一点。
ALLOW_CUSTOM_MIMO_BASE_URL=false
TTS_CACHE_LIMIT_MB=8192
TTS_CACHE_TTL_DAYS=90
```

说明：

- `.env` 是真实运行配置，可以放真实密码和 API Key。
- `.env.example` 是示例文件，不应放真实密钥。
- `APP_PASSWORD` 至少使用 12 位非默认密码；程序会拒绝用示例密码或常见弱密码提供服务。
- `SECRET_KEY` 留空时会自动生成到 `config/secret_key`，文件权限为 `0600`；也可以自己填写至少 32 位随机值。
- `HOST` 控制服务监听地址：`127.0.0.1` 仅允许本机访问；`0.0.0.0` 会监听所有网络接口，只有确实需要从其他机器直连时才应使用。
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
- 点击翻译结果中的句子会高亮对应原文，句数无法精确对应时退回高亮对应段落。
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

开启后仍只接受 HTTPS，并拒绝本机、内网、保留地址等非公网地址。为避免浏览器用户改变携带 API Key 的服务端请求目的地，Base URL 只能在服务器 `.env` 中修改，网页中始终只读。

## DeepSeek 缓存与费用

在线翻译的“配置 → DeepSeek”会显示当前缓存条数和容量上限，并提供带二次确认的清空缓存按钮。

服务端使用 SQLite 持久化缓存：

- 缓存上限：500 条
- 每条翻译完成后立即通过事务写入 `config/deepseek_cache.sqlite3`
- 服务重启后会继续读取原缓存，不会因进程退出而清空
- 多个 Gunicorn worker 共用同一个缓存文件
- 缓存按最近使用时间淘汰，超过 500 条时自动删除最久未使用的记录
- DeepSeek 按非空段落缓存，不再按整篇原文缓存
- 空白行不进入缓存，但展示结果会按原文换行结构拼回
- 原文没有空白行时，DeepSeek 结果也不会额外插入空白行
- 超过 12000 字符的单段翻译结果不缓存
- 单次翻译文本上限：20000 字符
- 命中本地缓存时不请求 DeepSeek API，不消耗 token

缓存文件包含翻译结果，权限会收紧为 `0600`，其所在 `config/` 目录为 `0700`。缓存不会提交到 Git；如果翻译内容敏感，备份和迁移时也应按私人数据处理。可在“在线翻译 → 配置”中清空。

缓存键包含：

- 非空段落文本
- 源语言
- 目标语言
- 模型
- temperature
- thinking
- reasoning effort
- 翻译风格

只要这些参数一致，同一段落就会命中本地缓存。比如在已有原文后追加新段落时，旧段落会直接读取缓存，只把新增段落发给 DeepSeek。重复段落在同一次请求中也只翻译一次。

这个本地缓存比 DeepSeek 官方上下文缓存更直接，因为命中时完全不发 API 请求。

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
- 查询失败后 15 秒内不会反复请求 DeepSeek 官方接口。

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
- TXT 在新导入或主动重新解析时，会从文件名和正文开头的“作者：…”信息识别作者；书名和作者都可以在书籍管理中手动修改，手动作者不会被重新解析覆盖。
- 书籍管理中的 TXT 目录支持改名、添加和删除；EPUB 目录来自书籍自身的 nav/spine，可在管理中查看但不直接改写，避免章节资源和图片引用错位。
- PDF 使用 `pypdf>=6.14.2` 提取文本；该最低版本包含多项恶意 PDF 资源耗尽修复。扫描版 PDF 如果没有文本层，无法直接阅读。
- MOBI/AZW3 暂未启用。

阅读功能：

- 书架按最后打开时间排序。
- 书架启动只读取轻量 `books.json` 索引，不重新解析原书，也不逐本读取完整正文记录；只有索引缺失或与书籍目录不一致时才自动重建。阅读进度和书籍信息更新只改对应索引项。
- 书架页提供现有阅读统计，按最近打开时间倒序展示每本书的当前章节、按章节估算的进度和最近打开时间；返回书架时会立即同步最新位置，当前版本不采集阅读时长。
- 书籍管理按导入时间由新到旧排序。
- 支持编辑书名和作者、删除书籍、重新解析书籍。
- 保存当前章节和句子进度。
- 支持目录跳转、上一章、下一章。
- 支持字体大小、字体切换和黑暗模式。
- 自定义字体全部使用 WOFF2；包含写意体和随峰体 Plus 后，原始字体资源约 68.9MiB，网页字体约 35.4MiB。字体按选择加载，不会在页面启动时下载全部资源。
- 字体设置中会显示每款字体的大小和“未加载 / 加载中 / 已加载 / 加载失败”状态，并提供小型手动加载按钮。所有字体加载都先查询浏览器专用 Cache Storage；写意体是登录后标题必需字体，本地没有时会自动请求一次并保存，本地已有时直接激活；其他字体只有主动选择或点击“加载/重试”时才允许从服务器请求。打开阅读设置只检查并激活本地字体，不会自动下载其他字体。下载响应会直接注册为二进制 `FontFace` 并同时写入本地缓存，避免 CSP 拦截和重复请求。
- 字体资源不经过登录 Session，使用公开的一年 `immutable` 浏览器缓存。字体 URL 带内容版本号；字体文件升级时同步更新版本号即可拉取新文件，不会继续使用旧字体。
- 浏览器会显式确认所选字体加载成功，并在页面从后台恢复时重新校验，避免 Chrome/macOS 长时间阅读后回退到系统字体。
- 手机端顶部阅读控制区固定，方便长文阅读时切换章节。
- 从具体书籍使用浏览器或手机系统返回键时会先回到书架，再次返回才会离开在线读书。
- 阅读页会同步页面背景和浏览器主题色。iPhone Safari 在原生对话框仍打开时，可能延迟刷新状态栏颜色；关闭弹窗后会采用已经切换的颜色，这是 WebKit 顶层界面的显示限制，不影响页面主题本身。
- 安装到桌面后，阅读页会在首屏绘制前恢复已保存的主题，并让背景延伸到系统安全区。Android 底部手势条属于浏览器/系统原生界面，网页会提供深色主题和背景提示，但最终颜色仍可能因 Chrome、Android 版本或手机厂商而不同。

内置字体选项包括：

- 系统字体
- 楷体
- 霞鹜文楷
- 思源宋体
- 思源黑体
- 清松手写体
- 写意体
- 随峰体Plus

字体来源与版权声明：

- 思源宋体来自 Adobe 官方的 [Source Han Serif](https://github.com/adobe-fonts/source-han-serif) 项目。字体内版权声明为 © 2017-2024 Adobe，保留字体名称 `Source`，使用 SIL Open Font License 1.1。
- 思源黑体来自 Adobe 官方的 [Source Han Sans](https://github.com/adobe-fonts/source-han-sans) 项目。字体内版权声明为 © 2014-2025 Adobe，保留字体名称 `Source`，使用 SIL Open Font License 1.1。
- 其他字体来源包括 [清松手写体官方仓库](https://github.com/jasonhandwriting/JasonHandwriting)、[霞鹜文楷官方仓库](https://github.com/lxgw/LxgwWenKai)、[写意体官方仓库](https://github.com/Steve-Yuu/YShi-Written) 和 [随峰体 Plus 官方页面](https://cjkfonts.io/blog/ThePeakFontPlus)。

字体的完整来源、转换说明和许可证信息见 `static/fonts/FONT_LICENSES.md`；SIL Open Font License 1.1 全文见 `static/fonts/OFL-1.1.txt`。

页面字体资产和许可说明放在：

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
- 查看接口地址（地址只能由服务器 `.env` 修改）
- 余额 Cookie（通过独立“配置Cookie”弹窗更新）
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
- 定时暂停会等当前句读完；在允许网页控制媒体音量的浏览器中，会在结束前约 7 秒逐渐降低音量后暂停。iOS Safari 不允许 JavaScript 修改媒体音量，因此会直接在句末暂停。
- 浏览器支持 Media Session 时，系统媒体界面会显示书名、章节和站点图标，并提供播放、暂停和停止控制。
- 页面使用 Screen Wake Lock 尽量在前台朗读时保持屏幕常亮；定时暂停、手动暂停或停止后会立即释放。切到后台时浏览器会释放屏幕常亮限制。
- 安装到桌面不会获得绕过系统省电策略的权限。后台朗读仍受 iOS/Android 和浏览器的音频调度限制；当前实现不包含 Service Worker，也不提供离线页面缓存。

MiMo 余额显示：

- 听书页面会显示 MiMo 余额和最后更新时间，并提供“配置Cookie”“MiMo控制台”和“重新查询”按钮。
- 余额查询通过后端代理请求 `MIMO_BALANCE_URL`。
- 前端不会获得 MiMo API Key 或已保存的余额 Cookie。
- 余额 Cookie 通过独立弹窗更新，保存后立即查询余额。
- 用户可以粘贴完整 Cookie，但后端只保留 `api-platform_serviceToken`、`userId`、`api-platform_ph` 和 `api-platform_slh` 四个白名单字段；前两个字段必须存在。
- Cookie 通常会随小米网页登录态变化而失效。确认失效后会保留并持久化最后一次成功余额，标记“数据已过期”，同时暂停自动查询；更新 Cookie 后会立即查询并恢复刷新。
- 后端不主动定时查询余额；只有前端页面请求时才会查询。
- 余额查询成功后缓存 15 分钟；自动查询失败后等待 15 秒再重试，手动“重新查询”会立即结束倒计时并直接查询。
- Cookie 未过期时，临时查询失败会保留已有余额，显示具体原因和 15 秒重试倒计时。
- Cookie、配置、请求过快和上游网络错误会区分返回，便于判断是否需要更新 Cookie。

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
- 默认大小上限：`TTS_CACHE_LIMIT_MB=8192`
- 默认有效期：`TTS_CACHE_TTL_DAYS=90`
- 清理策略同时看大小和过期时间。

缓存键包含：

- 文本
- 模型
- 音色
- 音频格式
- 风格/音色描述

因此切换音色不会删除旧的服务器缓存；以后切回同一音色、同一文本、同一配置时仍可命中。命中服务器缓存时不会调用 MiMo API，不消耗 token。

缓存键只包含实际影响 MiMo 音频结果的参数。当前版本不再读取旧缓存规则生成的文件，升级时应清空旧音频缓存，之后所有音频只按新规则保存。当前句会显示服务器缓存是否命中；未命中时显示 MiMo 生成耗时，不再展示磁盘检查、网络往返、缓存写入、音频下载和浏览器解码等短暂耗时。

听书会按当前句长度和播放倍速动态选择后续语句，并严格按照阅读顺序逐句预取：正常倍速通常预取 2–5 句，倍速提高时最多扩展到 7 句。紧邻下一句始终优先，避免多个 MiMo 请求同时生成、占满服务进程；走到下一句时若预取仍未结束，会复用正在进行的请求而不会重复生成。接近章尾时，这套动态规则会完整延伸到下一章，提前读取下一章并按其开头文本预取 2–5 句，倍速较高时最多 7 句；自动换章会直接接管这批结果，服务端仍然逐句生成和缓存。

为减少手机浏览器在连续播放很短音频时暂停的概率，当前句不足 5 秒时，浏览器会尝试把已取得或正在预取的相邻 WAV 音频拼成至少约 6 秒的一次播放，最多合并 6 句。接近章尾时，浏览器还会把下一章已预取的开头语音接入同一个临时播放流，避免 Android Chrome 在章节边界把媒体视为播放完毕并撤掉系统媒体控件。所有合并都只发生在浏览器播放层：服务端仍按原来的逐句文本生成、命中和保存缓存，不改变缓存键，不会因为合并重复消耗 MiMo token。句子高亮、阅读进度和定时暂停仍按原句边界处理。

## 监控

登录后在主页点“监控”，可以查看：

应用程序：

- 进程 PID
- 运行时间
- CPU 占用率
- 内存占用：占用量和占用率
- DeepSeek 缓存条数
- 听书音频缓存条数、容量、上限和有效期

系统：

- CPU 占用率
- 内存占用率和剩余内存
- 系统负载
- 磁盘占用率和剩余磁盘

操作：

- 刷新
- 重启服务，带二次确认
- 验证当前密码后修改总入口访问密码；新旧密码不能相同，修改后其他浏览器中的旧会话会失效

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
- 修改总入口密码必须先验证当前密码，新旧密码不能相同；连续验证失败会触发限速。
- API Key 保存到 `.env`。
- MiMo 余额 Cookie 不从 `.env` 读取或写入，只保留四个白名单字段，与最后成功余额和过期状态一起保存在私有的 `config/mimo_balance_state.json` 中。
- 浏览器配置页只允许提交新 Key。
- 服务端不会把真实 Key 或已保存的余额 Cookie 返回给浏览器。
- 配置页只显示“已配置，留空不修改”。
- `.env` 写入会清洗换行，避免注入额外环境变量。
- `.env`、应用密钥、MiMo 余额状态、DeepSeek 缓存、书籍和音频缓存文件使用私有权限；它们仍属于服务器敏感数据，不应公开、备份到不可信位置或提交到 Git。
- Session Cookie 设置了 `HttpOnly` 和 `SameSite=Lax`。
- 可通过 `SESSION_COOKIE_SECURE=true` 强制会话 Cookie 仅在 HTTPS 下发送。
- 登录失败带轻量限速：同一 IP 在 5 分钟内失败 8 次后会暂时拒绝继续尝试。
- 写请求会检查 `Origin` 和 `Referer`，降低 CSRF 风险。
- 所有写请求还必须携带会话内 CSRF token；只伪造表单或省略 `Origin` 无法绕过。
- 响应头包含 CSP、HSTS、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin` 和收紧的 `Permissions-Policy`。
- 登录页、功能页和 API 响应使用 `Cache-Control: no-store`，避免私人书籍和配置残留在共享缓存。
- 修改访问密码后，其他浏览器中的旧登录 Cookie 会立即失效。
- 监控接口只读取固定 `/proc` 信息和项目目录磁盘占用，不接受浏览器传路径。
- 重启接口不通过 shell 拼接浏览器参数，但登录用户可以触发服务重启，因此密码必须足够强。
- 书籍导入只写入 `reader_data/books/<book_id>`，`book_id` 限制为 32 位十六进制字符串。
- 书籍导入限制文件大小和扩展名，EPUB 解析限制解压总量和单图片大小，降低异常文件消耗资源的风险。
- EPUB 图片资源只允许读取书籍 EPUB 内部的图片文件，并限制单图大小。
- EPUB 不执行书内脚本，只提取文本和图片。
- DeepSeek 和 MiMo 的自定义接口地址默认关闭；即使在服务器开启，也会拒绝本机、内网、保留地址，不跟随上游重定向，并且浏览器无权修改地址，降低 SSRF 和 API Key 外泄风险。
- EPUB 限制文件数、单文件大小和总解压大小；普通外部 `DOCTYPE` 会在解析前移除且不会访问外部 DTD，实体声明和内部 DTD 会被拒绝；PDF 限制页数和总提取文本量。

如果通过公网访问本工具，必须在 Nginx、Caddy 或 Cloudflare 上配置 HTTPS，并设置 `SESSION_COOKIE_SECURE=true`。使用 Cloudflare 时应选择 `Full (strict)`，避免 Cloudflare 到源站之间退回明文 HTTP。浏览器请求里的密码不是客户端哈希值，而是由 HTTPS 连接加密传输；服务端 `.env` 仍属于必须保护的敏感文件。

示例配置为了兼容当前部署，设置了 `ALLOW_ROOT_RUN=true`，因此允许服务由 root 启动。如果删除该配置或改为 `false`，程序会拒绝以 root 启动或处理请求。这个开关只是显式解除保护，并不能降低 root 服务被利用后的系统风险；公开部署仍建议使用单独低权限用户，并交给 systemd、gunicorn 或类似进程管理器管理。

如果之前曾用 root 运行，切换用户前要把 `.env`、`config/`、`logs/` 和 `reader_data/` 的所有权交给新的服务用户；不要把整个系统目录开放成可写。例如服务用户叫 `trans` 时，可按实际存在的路径执行 `chown -R trans:trans ...`。书籍、缓存、配置和日志会使用尽量收紧的目录/文件权限。

生产环境示例（仍只监听本机，由 Nginx/Caddy 提供 HTTPS）：

```bash
gunicorn --workers 2 --bind 127.0.0.1:31000 app:app
```

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

- 本项目使用 GNU Affero General Public License v3.0，许可证全文见 `LICENSE`。
- `static/fonts/` 中的字体不适用项目 AGPL；其版权和再分发条件见 `static/fonts/FONT_LICENSES.md` 与 `static/fonts/OFL-1.1.txt`。
- 如果基于本项目修改后作为在线服务提供给用户使用，也需要按 AGPL-3.0 向这些用户提供对应源码。
- 外部贡献默认按 AGPL-3.0 许可进入本项目。
- 不要把真实 `.env` 提交到公开仓库。
- 不要把 `config/deepseek_cache.sqlite3` 提交到公开仓库，其中包含翻译结果。
- 不要把 `reader_data/` 提交到公开仓库，里面可能包含私人书籍和 TTS 音频缓存。
- 修改 `.env` 后需要重启服务。
- 修改模板或后端代码后需要重启服务。
- 修改 CSS/JS 后通常刷新页面即可，静态资源 URL 会自动带版本参数。
