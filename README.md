<p align="center">
  <img src="static/site-icon.svg" width="112" height="112" alt="Trans 图标">
</p>

<h1 align="center">Trans</h1>

<p align="center">集在线翻译、阅读与听书于一体的自部署工具网站</p>

<p align="center">
  <a href="https://github.com/bran136/Trans/releases/latest"><img src="https://img.shields.io/github/v/release/bran136/Trans?display_name=tag&amp;sort=semver&amp;label=%E7%89%88%E6%9C%AC" alt="最新版本"></a>
  <a href="https://github.com/bran136/Trans/actions/workflows/ci.yml"><img src="https://github.com/bran136/Trans/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/bran136/Trans" alt="许可证"></a>
</p>

在线翻译支持 DeepSeek 与谷歌翻译、结果对比、原文高亮、历史记录和翻译缓存；内含 PDF 翻译，支持中英互译、双语对照 PDF 和任务管理。

在线读书支持 TXT/EPUB/PDF 书架、目录与正文搜索、进度同步、字体切换、黑暗模式和电脑端 TXT 全文编辑，并提供 Xiaomi MiMo 听书及音频缓存。

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#环境配置">环境配置</a> ·
  <a href="#在线翻译">在线翻译</a> ·
  <a href="#pdf-论文翻译">PDF 翻译</a> ·
  <a href="#在线读书">在线读书</a> ·
  <a href="#听书">听书</a> ·
  <a href="#安全说明">安全说明</a>
</p>

## 功能概览

- 使用共享密码登录，可选开启验证器双重验证（2FA）和一次性恢复码；支持通行密钥，通过设备指纹、人脸或锁屏密码快速登录。不提供注册和用户体系。
- 登录后进入工具入口页，可选择“在线翻译”或“在线读书”。
- 翻译与读书使用独立页面，共用登录入口和登录态；PDF 翻译从在线翻译页打开。
- 主页提供设置、服务监控与关于页面，可管理登录安全、查看运行状态和功能介绍。
- 采用共享访问密码，书架、阅读进度和服务配置由登录用户共用；文本翻译历史和本机音频缓存保存在各自浏览器。
- 提供站点图标和 Web App Manifest；支持的手机浏览器可将网站安装到桌面，以独立窗口打开。
- 页面统一显示“正式版本 + 构建指纹”和 GitHub 入口，例如 `v1.5+a07a6f8b`；页面资源变化后指纹和资源 URL 会自动更新。
- Session Cookie 默认有效期为 30 天。

## 快速开始

建议使用 Linux 和 Python 3.11–3.13；这三个 Python 版本均纳入 GitHub Actions 自动检查。

```bash
git clone https://github.com/bran136/Trans.git
cd Trans
cp .env.example .env
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
# 先编辑 .env，至少替换 APP_PASSWORD
python3 app.py
```

`requirements.txt` 约束了 Flask、requests、pypdf、urllib3 和 idna 的安全最低版本。已有环境也应重新执行安装命令完成升级，不能只重启旧环境。

使用 MiMo 听书时，服务端统一输出 AAC-LC/M4A（单声道、80 kbps），必须安装同时提供 `ffmpeg` 和 `ffprobe` 的 FFmpeg 软件包：

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends -y ffmpeg
ffmpeg -version
ffprobe -version
```

正式版本见 [`VERSION`](VERSION)，更新记录见 [`CHANGELOG.md`](CHANGELOG.md)。页面版本附带八位构建指纹，前端资源变化后刷新即可更新指纹与资源地址。更新版本号或 Python 后端文件后需重启服务。

默认地址：

```text
http://127.0.0.1:31000
```

默认只监听 `127.0.0.1`，端口由 `.env` 中的 `PORT` 控制。需要从其他机器直接访问时，可以把 `HOST` 改为 `0.0.0.0` 并使用强密码；更推荐继续监听本机，通过 HTTPS 反向代理访问。

主要入口：

```text
/               主页
/login          登录页
/translate      在线翻译
/translate/pdf  PDF 翻译（从在线翻译页进入）
/reader         在线读书
```

## 目录

以下路径均相对于项目根目录；运行数据首次使用时自动生成。

```text
app.py                            应用入口、在线翻译、阅读与听书
reader_search.py                  书籍正文搜索与索引
pdf_translation.py                PDF 翻译服务接入、任务与文件管理
templates/                        页面模板
static/                           页面样式、脚本、图标与字体
scripts/migrate_wav_cache_to_m4a.py 旧音频缓存迁移工具
VERSION / CHANGELOG.md            正式版本与更新记录
requirements.txt / .env.example   依赖与环境配置示例
.env                              访问密码、在线翻译与听书 API Key
config/
  service_config.example.json     服务接口配置示例
  service_config.json             服务接口默认值和备选列表
  app_config.json                 普通页面配置，不保存真实 API Key
  secret_key                      自动生成的会话签名密钥
  security.json                   双重验证、通行密钥公钥、登录设备及验证状态（私有）
  deepseek_cache.sqlite3          文本翻译缓存
  mimo_balance_state.json         MiMo 余额、过期状态及余额 Cookie
reader_data/
  books.json                      书架索引
  books/                          原书、章节、进度、搜索索引及 TXT 备份
  tts_cache/                      单句音频缓存
  tts_pack_cache/                 播放包缓存
  tts_offline.sqlite3             服务器固定音频记录
  tts_pack_index.sqlite3          播放包归属索引
  tts_cache_stats.json            音频缓存统计摘要
pdf_data/
  config.json                    PDF 配置及独立 API Key（如已填写）
  tasks.sqlite3                  PDF 任务记录
  <任务ID>/                      各任务上传原文与翻译结果
logs/app.log                      应用日志
```

`.env`、实际配置、书籍、PDF 文件、缓存和日志等私有运行数据已加入 `.gitignore`。迁移或备份时应一并保护这些文件，不要提交到公开仓库。

## 环境配置

`.env.example` 中包含完整示例：

```env
PORT=31000
HOST=127.0.0.1
APP_PASSWORD=replace-with-a-strong-password
SECRET_KEY=
SESSION_COOKIE_SECURE=false
TRUSTED_PROXY_CIDRS=
ALLOW_ROOT_RUN=true

DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=false

MIMO_API_KEY=
MIMO_TTS_BASE_URL=https://api.xiaomimimo.com/v1/chat/completions
MIMO_BALANCE_URL=https://platform.xiaomimimo.com/api/v1/balance
MIMO_TTS_MODEL=mimo-v2.5-tts
MIMO_TTS_VOICE=冰糖
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
- 在线翻译和听书的 API Key 保存到 `.env`；PDF 独立配置的 Key 保存到 `pdf_data/config.json`。前端仅显示配置状态，留空保存不会覆盖原 Key。
- 如果只通过 HTTPS 域名访问，建议设置 `SESSION_COOKIE_SECURE=true`。
- 如果直接用 `http://服务器IP:31000` 调试，`SESSION_COOKIE_SECURE=true` 会导致浏览器不发送登录 Cookie。
- 使用反向代理时，将 `TRUSTED_PROXY_CIDRS` 设置为代理的实际 IP 或网段，多个值用逗号分隔，才能正确识别客户端 IP；默认不信任转发头，不要填入公网任意来源。
- 如果前面还有 Cloudflare，需同时加入其[官方代理网段](https://www.cloudflare.com/ips/)，并由反向代理正确追加 `X-Forwarded-For`；代理地址变化时同步更新配置。
- `TRUSTED_PROXY_CIDRS` 优先读取 `.env` 中的配置，文件中不存在该项时使用进程环境变量；修改后重启生效，留空可关闭对转发头的信任。

## 在线翻译

支持引擎：

- `DeepSeek`：由服务器代理请求官方 API，保护 API Key。
- `谷歌翻译`：优先使用服务器网络，失败后回退到浏览器网络；接口地址可以从服务配置提供的列表选择，也可以自行填写公网 HTTPS 地址。

主要行为：

- 默认源语言为自动检测，默认目标语言为中文。
- 当源语言手动设置为中文，或自动检测为中文时，目标语言自动推荐英语。
- 可同时勾选 DeepSeek 和谷歌翻译。
- DeepSeek 可设置模型、温度、思考参数和翻译风格，提供默认、学术翻译、文学创作、商务正式、通俗易懂五种风格。
- 哪个翻译引擎先返回，哪个结果先显示，不等待最慢的引擎。
- 默认展开前两个翻译结果。
- 每个结果卡片支持折叠、展开和一键复制。
- 点击翻译结果中的句子会高亮对应原文，句数无法精确对应时退回高亮对应段落。
- 折叠状态会在当前页面会话中保持，刷新后恢复默认。
- 本地浏览器历史记录默认保留 100 条。

### PDF 论文翻译

从在线翻译页的 **PDF** 按钮进入独立页面，支持英语与中文互译，默认英语 → 中文。可选择生成译文 PDF、左右对照 PDF（左原文、右译文），默认两种都生成。

- 单文件上传、串行处理，正在进行与历史任务分标签展示，支持进度与详情查看、历史搜索、结果预览、下载和任务删除。关闭页面后仍在后台继续。
- 支持文件传输进度；翻译阶段、阶段计数与总百分比取决于上游提供的信息，未提供时显示处理中。
- 使用 DeepSeek，模型及论文参数独立设置，可复用在线翻译的 API Key；不继承其翻译风格，使用上游内置提示词。默认关闭 OCR 兼容模式和表格文本翻译，禁用自动术语提取，字体自动，输出无水印。
- 可设置思考强度（支持的模型）、请求速率（QPS）、单个 PDF 的并发 Worker 数、富文本样式和 PDF 兼容性。页面提供参数说明及服务连接检测；跳过末尾页数在上传区按任务设置，0 表示全文翻译。任务详情可查看创建时的配置。
- 任务默认保留至手动删除，也可设置结束后的保留天数。排队任务可取消，已提交上游的任务暂不支持中途取消。待核对时可打开上游，确认未创建或已结束后取消本地跟踪；结束后的任务可删除。上游副本、缓存和日志需单独清理。
- 上传连接中断或上游记录缺失时，任务可能进入“待核对”并暂停后续队列，不会自动重复提交。先通过“打开上游”核对：结果完整时选择“取回结果”，确认未创建或已结束且无需取回时选择“取消”。取消保留原文件，需要重新翻译时重新上传。

首次使用需单独部署 [Zotero PDF2zh](https://github.com/guaguastandup/zotero-pdf2zh)，确保其 `pdf2zh_next` 引擎可用，并在服务配置中填写 Trans 服务器可访问的内网 IP 与端口。无需安装 Zotero 客户端；未部署该服务时，仅 PDF 翻译不可用。上传大小还受反向代理和上游服务限制。

文档和密钥会交给配置的服务，待翻译文本发送至 DeepSeek，请仅接入可信服务并上传有权处理的文件。默认不翻译表格文本，不启用图片 OCR；具体识别范围与排版保留效果取决于上游分析。PDF 配置、任务和文件保存在 `pdf_data/`，已从 Git 排除。

### DeepSeek 配置和安全

默认：

```env
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=false
```

以下设置用于在线文本翻译；PDF 翻译的 DeepSeek 使用官方接口，不继承文本翻译的自定义地址、模型或风格。

配置页中的 DeepSeek `Base URL` 始终只读。默认只允许官方地址：

```text
https://api.deepseek.com
```

这样可以避免浏览器用户把服务器诱导到恶意地址，间接泄露 DeepSeek API Key。

如果确实需要使用自建代理或兼容网关，可以在 `.env` 中开启：

```env
ALLOW_CUSTOM_DEEPSEEK_BASE_URL=true
```

开启后仍只接受 HTTPS，并拒绝本机、内网、保留地址等非公网地址。为避免浏览器用户改变携带 API Key 的服务端请求目的地，Base URL 只能在服务器 `.env` 中修改，网页中始终只读。

### DeepSeek 缓存与费用

在线翻译的“服务配置 → DeepSeek”可调整缓存条数上限、查看当前用量，并提供带二次确认的清空缓存按钮。

服务端使用 SQLite 持久化缓存：

- 缓存默认上限：5000 条，可设置为 1～100000 条
- 缓存保存在 `config/deepseek_cache.sqlite3`，重启后仍可复用
- 缓存按最近使用时间淘汰，超过上限或保存更小的上限时，自动删除最久未使用的记录
- DeepSeek 按非空段落缓存，不再按整篇原文缓存
- 空白行不进入缓存，但展示结果会按原文换行结构拼回
- 原文没有空白行时，DeepSeek 结果也不会额外插入空白行
- 超过 12000 字符的单段翻译结果不缓存
- 单次翻译文本上限：20000 字符
- 命中本地缓存时不请求 DeepSeek API，不消耗 token

缓存文件包含翻译结果，权限会收紧为 `0600`，其所在 `config/` 目录为 `0700`。缓存不会提交到 Git；如果翻译内容敏感，备份和迁移时也应按私人数据处理。可在“在线翻译 → 配置”中清空。

缓存按段落、语言、模型、温度、思考设置、翻译风格和提示词版本区分。参数一致时，追加新段落只需翻译新增内容；同一次请求中的重复段落也只翻译一次。此缓存用于在线文本翻译，PDF 翻译缓存由独立上游服务管理。

### DeepSeek 余额

主界面翻译引擎里会显示 DeepSeek 余额和更新时间：

```text
DeepSeek (¥xx.xx · 02:31)
```

余额查询由后端代理，前端不会获得 DeepSeek API Key。

刷新策略：

- 后端不主动定时查询。
- 只有打开前端页面时才会请求余额接口。
- 页面切到后台时不主动刷新。
- 页面重新可见时，超过 15 分钟才刷新。
- 后端也有 15 分钟余额缓存。
- 查询失败后 15 秒内不会反复请求 DeepSeek 官方接口。

余额查询使用 DeepSeek 官方 `GET /user/balance`，不是模型推理接口，不产生翻译 token。

## 在线读书

支持 TXT、EPUB 和带文本层的 PDF。

导入和解析：

- 导入文件最大 50MB。
- 最多允许 2 本书同时导入解析。
- EPUB 导入时只建立目录和索引，章节按需解析并缓存，降低导入等待和内存占用。
- EPUB 会限制解压后总大小，避免异常文件占用过多资源。
- EPUB 支持读取封面和正文图片。
- TXT 会智能识别章节；书籍管理中可重新解析，TXT 还支持清除目录信息后作为全文阅读。
- TXT 在新导入或主动重新解析时，会从文件名和正文开头的“作者：…”信息识别作者；书名和作者都可以在书籍管理中手动修改，手动作者不会被重新解析覆盖。
- 书籍管理中的 TXT 目录支持改名、添加和删除；EPUB 目录来自书籍自身的 nav/spine，可在管理中查看但不直接改写，避免章节资源和图片引用错位。
- PDF 提取文本供阅读，不保留原版式；扫描版没有文本层时无法直接阅读。阅读导入最多 5,000 页，总提取文本上限为 300 万字符。
- MOBI/AZW3 暂未启用。

阅读功能：

- 书架按最近打开时间排序并显示当前章节、估算进度和最近打开时间；启动时优先读取轻量索引，不重复解析原书。
- 书籍管理按导入时间由新到旧排序。
- 支持编辑书名和作者、删除书籍、重新解析书籍。
- 阅读进度与选句高亮独立：书籍打开后每 5 秒检查最后完整可见的句子，仅在位置变化时保存；听书时记录正在播放的位置。返回书架或离开页面时补存进度。
- 阅读统计按书展示临时缓存、服务器固定及本机下载的容量、章节和覆盖率，点击明细可管理听书缓存。覆盖率按当前听书配置的句数去重计算，索引不足时显示待统计。停止听书 5 秒后或缓存、书籍内容变更后自动更新；手动刷新可重新读取进度并校准缓存统计。
- 支持目录跳转、上一章、下一章；点击章节标题可筛选目录，或切换到“正文”搜索并跳转到匹配位置。首次正文搜索需要稍等片刻。
- 书架和书籍管理支持搜索书名、作者。
- 电脑端可在“管理 → 编辑 → 编辑 TXT 全文”中修改原文，支持章节导航、查找替换、修改高亮及逐条撤销。
- Ctrl / ⌘ + S 仅保存原文；点击“保存并解析”后才更新阅读内容和目录。读写使用压缩传输，保存时只上传差异，节省流量。
- 同一本书同时只能在一个页面编辑，退出后释放；异常退出后最多等待 5 分钟即可重新进入。
- 自动保留最近一次修改前的原文备份，可下载、删除或载入恢复。备份在下次修改并保存时覆盖，删除书籍时一并删除。
- 支持字体大小、字体切换和黑暗模式。
- 自定义字体使用 WOFF2 并按需加载，不会在页面启动时下载全部字体。
- 字体设置显示加载状态并支持手动加载；已下载字体保存在浏览器 Cache Storage 中。
- 字体资源使用带内容版本的长期缓存，文件变化后会请求新版本。
- 手机端顶部阅读控制区固定，方便长文阅读时切换章节。
- 从具体书籍使用浏览器或手机系统返回键时会先回到书架，再次返回才会离开在线读书。
- 阅读页会恢复已保存的主题并同步浏览器主题色；安装到桌面后适配系统安全区，状态栏和手势区的最终效果取决于浏览器与操作系统。

内置字体选项包括：

- 系统字体
- 楷体（仅在浏览器可调用本机楷体时显示）
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
- 是否复用服务端单句缓存

当前模型：

```text
mimo-v2.5-tts
```

当前预置音色选项（默认冰糖；旧配置中的 `mimo_default` 按冰糖处理）：

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
- 可以暂停、停止、快速切换音色，并选择 0.8、1、1.2、1.5、2 倍速（默认 1 倍）。
- 可以设置定时暂停，支持 5、10、15、30、45、60 分钟和自定义分钟数。
- 定时暂停会等当前句读完；浏览器支持网页调节音量时，会在结束前渐弱，否则直接在句末暂停。后台效果受浏览器和系统调度影响。
- 浏览器支持 Media Session 时，系统媒体界面会显示书名、章节和站点图标，并提供播放、暂停和停止控制。
- 页面使用 Screen Wake Lock 尽量在前台朗读时保持屏幕常亮；定时暂停、手动暂停或停止后会立即释放。切到后台时浏览器会释放屏幕常亮限制。
- 安装到桌面不会绕过系统省电策略，后台朗读仍受 iOS/Android 和浏览器的音频调度限制。

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

听书使用三处存储：

1. 当前页面的浏览器内存
2. 当前浏览器的 IndexedDB 本机缓存
3. 服务器磁盘缓存

服务器按单句生成和复用 AAC/M4A 语音，再组成带句子时间轴的播放包。听书优先读取本机缓存，缺少时请求服务器；音频在浏览器中重新封装并追加到同一条播放时间轴，跨包、跨章节不再重载播放器。封装转换不调用模型，也不需要重新下载现有本机缓存。

播放包达到 5.1 秒安全门槛后即结束，章节末尾不足的部分并入前包；单句自身达到门槛时可直接作为播放包。门槛按音频原始时长计算，不受播放倍速影响。

“服务器固定”会保留所需的单句语音和播放包，避免被普通缓存淘汰，不会重新调用 MiMo 生成另一份相同语音。达到门槛的单句包只保存索引并读取原 M4A，不重复存储音频。

“固定并下载到本地”把完整播放包保存到 IndexedDB。本机与服务器音频共用连续播放、进度和定时控制；命中本机缓存时不下载音频。旧版单句缓存及 v6 之前的播放包不兼容，升级时会清除并需重新下载；当前本机缓存数据库为 v8。

服务器磁盘缓存：

- 单句目录：`reader_data/tts_cache`
- 播放包目录：`reader_data/tts_pack_cache`
- 播放包归属索引：`reader_data/tts_pack_index.sqlite3`。用于快速查找和清理书籍关联的播放包。
- 示例配置上限：`TTS_CACHE_LIMIT_MB=8192`
- 示例配置有效期：`TTS_CACHE_TTL_DAYS=90`
- 未固定缓存按容量和有效期自动清理；固定缓存不会自动淘汰，取消固定后会清理不再引用的播放包。
- “复用服务端单句缓存”控制普通在线播放是否保留并复用单句语音；相同文本、模型、音色和风格命中时不会调用 MiMo API。
- 服务端和浏览器只持久化 AAC/M4A；旧 WAV 需按下方迁移说明转换。

听书设置底部将服务器存储分为普通缓存和固定内容：普通缓存受容量及有效期约束；固定内容不占用缓存上限，其容量包含全局去重后的单句 M4A、合成的多句播放包及播放包索引，均按文件系统实际分配空间统计。离线管理按当前书籍和音色显示章节关联数据，范围不同，数字不直接相加。

普通缓存的过期与容量清理在后台合并执行，不要求播放请求等待全量扫描；清理前及近期使用保护期间，容量可能暂时超过设定值。已有缓存无需迁移。

播放器根据音频准备耗时，以约 60–120 秒后续音频为缓冲目标（Safari 可自行调整实际缓冲），预取最多两包；服务端最多同时构建 3 个播放包。暂停或定时到期后停止继续预取，已发出的合成请求可能仍会完成；已播放音频及时从内存释放，不影响本机及固定缓存。准备期间点击“暂停”可取消，再点“继续”重新准备。

MiMo 限流、网络故障或服务繁忙时自动退避重试；连续播放期间保留已缓冲音频，恢复后继续。高风险拒绝及未识别的生成失败会按 3、5、10 秒间隔自动重试三次，等待期间保留播放会话，仍失败时提示处理；密钥、余额或明确的内容审核拦截不自动重试。

连续播放需要浏览器支持 AAC MediaSource 或 ManagedMediaSource；不支持时会提示使用最新版 Chrome 或 Safari 浏览器。章节正文仍需从服务器读取，音频本机缓存不等同于整站离线可用。手机系统中断或网络长期不可用仍可能影响后台播放。

支持本机连续播放的浏览器中，章节已完整下载且校验有效时，音频直接从 IndexedDB 播放，不再消耗音频流量；登录校验、页面、配置、章节正文和进度同步仍会产生少量请求。本机播放包缺失、配置不匹配或 IndexedDB 无法读取时，才会回退到服务器。

### 听书缓存

在“书籍管理”中，每本书都可以按章节执行：

- 章节状态显示服务器和本机已覆盖的句数；总句数首次计算后持久缓存，后续直接读取。
- 服务器固定：复用当前朗读配置的已有语音，只生成缺失句子，并固定本章全部播放包。
- 固定并下载到本地：先补齐服务器播放包，再把播放包和时间轴保存到当前浏览器；已有且校验有效的包会跳过。
- 固定并下载期间会在浏览器支持时阻止设备自动息屏；任务结束或关闭缓存页面后自动恢复。
- 删除本地缓存：只删除当前浏览器、当前朗读配置下选定章节的副本。
- 取消服务器固定：只移除固定标记，不删除各浏览器已经下载的副本。
- 只有播放包连续覆盖本章所有可朗读句子时，本章才显示为完整。
- 任务可以取消；已完成部分会保留，刷新页面后会恢复服务器任务监控及后续本机下载。

本机缓存按书籍、朗读配置和章节隔离。删除书籍或修改章节结构时会清理服务器引用及当前浏览器副本；其他设备中的副本需要在对应设备处理。

按书统计的容量包含可关联的全部音色音频；共享音频可能计入多本书，未能关联书籍的旧单句缓存仅计入全站统计，因此各书容量之和不等于全站磁盘占用。

当前实现不使用 Service Worker。已经打开的页面可以在弱网下播放本机音频；服务器完全不可达时，刷新或重新打开页面仍无法加载网页和章节正文。

### 浏览器保存时间

IndexedDB 没有统一的固定保存天数：

- 桌面 Chrome：普通窗口通常可长期保留；清除网站数据、删除浏览器配置或磁盘压力可能导致删除。无痕窗口关闭后删除。
- Android Chrome：普通模式通常可长期保留；清除应用数据、卸载浏览器或系统存储压力会删除。无痕模式关闭后删除。
- macOS Safari：没有固定期限；清除网站数据、长期未访问或磁盘压力可能触发回收。私人浏览关闭后删除。
- iPhone/iPad 浏览器与主屏幕 Web App：缓存可能因系统存储压力、清理网站数据或长期未使用而被回收，不应作为唯一副本。私人浏览的数据通常在会话结束后删除。

### WAV 缓存迁移

当前版本不直接读取 1.1 及更早版本的服务端 WAV 缓存。旧用户若要继续复用这些缓存，必须先停止服务并执行转换；转换不需要重新调用 MiMo。建议首次保留源文件：

```bash
cp -a reader_data reader_data.backup
python3 scripts/migrate_wav_cache_to_m4a.py --keep-source
```

转换后启动服务并确认听书正常。确认无误后，再停止服务并运行一次不带 `--keep-source` 的命令，脚本会验证已有 M4A、更新离线引用并删除对应 WAV。转换失败的 WAV 会保留，脚本可以重复运行。

旧浏览器 IndexedDB 中的单句 WAV 无法在本地可靠转换为 M4A 播放包，从旧版本升级时会自动清除旧单句和 v6 之前的分包；服务器缓存转换完成后，在该浏览器重新执行“固定并下载到本地”即可。全新安装不需要运行迁移脚本，正常运行也不会持久化 WAV 文件；MiMo 上游仍以 WAV 返回音频，但只在服务端内存中短暂存在，随后立即转为 M4A。

在 HTTPS 安全上下文且浏览器支持 Storage API 时，页面显示当前站点的估算用量、浏览器分配额度及持久化状态，例如 `本机存储 1.2 GB / 10.0 GB · 已持久化`；未获持久化授权时显示“可能被回收”。HTTP 下即使浏览器能提供容量估算，也不能申请持久化存储；完全无法估算时显示“HTTP 下无法查询本机容量”。下载前会尝试调用 `navigator.storage.persist()`，是否批准由浏览器决定，Safari 和 iOS 不保证批准。

## 设置与登录安全

主页“设置”提供双重验证、通行密钥、修改密码和已登录设备：

- **双重验证默认关闭**。点击“绑定验证器”，在弹窗内先验证当前密码，再用支持 TOTP 的验证器扫码或手动添加密钥，最后输入 6 位验证码确认启用。二维码由 Trans 本地生成，无需第三方二维码服务。
- 启用后，密码登录需要再输入验证码。保存好页面提供的 8 个恢复码，每个仅可使用一次，服务器只保存摘要。恢复码可代替验证码；验证后 5 分钟内，可凭当前密码重新生成恢复码或关闭双重验证，避免用完最后一个恢复码后无法恢复。
- 更换验证器时，先验证密码和验证码（或恢复码）关闭双重验证，再重新绑定。重新生成恢复码会使旧恢复码全部失效。
- 修改密码需要验证当前密码；已开启双重验证时，还需验证第二因素。密码至少 12 位，不能与原密码相同。密码或 2FA 设置变更后，其他浏览器需要重新登录，当前浏览器保留登录状态。
- 已登录设备显示浏览器、系统、IP、登录及最近活动时间，可刷新或单独退出某个客户端；退出当前客户端会返回登录页。同一浏览器的标签页共用记录，最近活动不代表实时在线。旧会话在升级后首次访问时补录，退出或过期后从列表移除。
- IP 地区通过 [IP9](https://www.ip9.com.cn/) 的 HTTPS 接口按需查询，无需注册或 API Key；仅发送公网 IP，不发送密码、密钥或浏览器信息。结果在内存中缓存，内网地址不外查。地区是网络归属地估算，不是设备的精确位置；查询失败不影响登录。

验证器和服务器应保持时间自动同步。请将恢复码与密码分开保管；备份、迁移时妥善保存 `config/security.json` 和会话签名密钥。双重验证密钥保存在仅服务用户可读写的私有文件中，并非加密备份；这些文件已加入 Git 忽略规则，不能公开。公网访问仍需 HTTPS。

### 通行密钥

在“设置 → 通行密钥 → 管理”中添加或删除密钥，最多支持 10 个，可查看名称、添加时间和最近使用时间。添加时先验证身份：未启用 2FA 时使用密码；启用后可选密码或验证码（也支持恢复码）。验证成功后，再填写名称并添加；当前浏览器的添加权限有效期为 10 分钟。

添加后，登录页可选择“使用通行密钥登录”，通过设备指纹、人脸或锁屏密码完成验证，无需再输入网站密码和 TOTP 验证码。生物识别由设备处理，Trans 只保存公钥；密码及原有 2FA 登录方式仍可使用。

通行密钥需要 HTTPS 域名、支持 WebAuthn 的浏览器和已设置的设备锁屏；本机开发可使用 `http://localhost`，服务器 IP 地址不支持。域名自动取自当前访问地址，无需在 Trans 中单独配置；反向代理需保留原始 `Host`（含非默认端口）。密钥按域名绑定，更换域名需重新添加；能否跨设备同步取决于系统或密码管理器。

修改访问密码不会删除已有通行密钥。设备丢失时，应删除对应密钥并退出相关客户端；删除服务器记录后，设备密码管理器中的副本也可自行移除。备份 `config/security.json` 只能保留公钥记录，不能替代设备上的私钥。

## 监控

登录后在主页点“监控”，可以查看：

应用程序：

- 进程 PID
- 运行时间
- CPU 占用率
- 内存占用：占用量和占用率
- DeepSeek 缓存条数
- 听书单句缓存条数、容量、上限和有效期

系统：

- CPU 占用率
- 内存占用率和剩余内存
- 系统负载
- 磁盘占用率和剩余磁盘

操作：

- 刷新
- 重启服务，带二次确认

监控刷新频率为 5 秒，仅在监控弹窗打开时自动刷新。重启后通过轻量接口确认新进程已恢复，再更新监控数据；90 秒内未确认恢复时会提示检查服务日志。

## 日志

应用日志保存在 `logs/app.log`，单文件约 2 MB，最多保留 5 个轮转备份。查看实时日志：

```bash
tail -f logs/app.log
```

记录登录与限速、配置更新、翻译和听书请求、书籍操作、缓存清理、服务重启及请求拦截等事件。排查问题时请先检查日志；向他人提供日志前应确认其中不含私人内容。

听书播放诊断批量记录播放、缓冲、暂停、定时到期和页面状态，包含书籍编号及播放位置，不包含正文或密钥。未发送记录在当前浏览器最多暂存 48 条，网络恢复或重新打开读书页后尝试补发；系统冻结页面期间无法记录新事件。

## 安全说明

- 登录密码不会返回前端。
- 修改总入口密码必须先验证当前密码，新旧密码不能相同；连续验证失败会触发限速。
- 在线翻译与听书 API Key 保存到 `.env`；PDF 独立 Key 保存到 `pdf_data/config.json`。
- MiMo 余额 Cookie 不从 `.env` 读取或写入，只保留四个白名单字段，与最后成功余额和过期状态一起保存在私有的 `config/mimo_balance_state.json` 中。
- 服务端不向浏览器返回真实 Key 或已保存的余额 Cookie；配置页只显示状态，Key 留空不修改。
- `.env` 写入会清洗换行，避免注入额外环境变量。
- `.env`、应用密钥、MiMo 余额状态、翻译缓存、PDF 配置与文件、书籍和音频缓存使用私有权限；它们仍属于服务器敏感数据，不应公开、备份到不可信位置或提交到 Git。
- Session Cookie 设置了 `HttpOnly` 和 `SameSite=Lax`。
- 可通过 `SESSION_COOKIE_SECURE=true` 强制会话 Cookie 仅在 HTTPS 下发送。
- 登录与安全设置验证共享限速：同一 IP 在 5 分钟内失败 8 次后，依次等待 1、3、5 分钟，最高 5 分钟；登录页显示倒计时。成功验证后重置当前 IP 的限速，30 分钟无失败后恢复初始级别；双重验证另有站点级失败限制。限速和验证码使用状态持久保存，重启后仍生效。
- 写请求会检查 `Origin` 和 `Referer`，降低 CSRF 风险。
- 所有写请求还必须携带会话内 CSRF token；只伪造表单或省略 `Origin` 无法绕过。
- 响应头包含 CSP、HSTS、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin` 和收紧的 `Permissions-Policy`。
- 登录页、功能页和 API 响应使用 `Cache-Control: no-store`，避免私人书籍和配置残留在共享缓存。
- 监控接口只读取固定 `/proc` 信息和项目目录磁盘占用，不接受浏览器传路径。
- 重启接口不通过 shell 拼接浏览器参数，但登录用户可以触发服务重启，因此密码必须足够强。
- 书籍导入只写入 `reader_data/books/<book_id>`，`book_id` 限制为 32 位十六进制字符串。
- 书籍导入限制文件大小和扩展名，EPUB 解析限制解压总量和单图片大小，降低异常文件消耗资源的风险。
- EPUB 图片资源只允许读取书籍 EPUB 内部的图片文件，并限制单图大小。
- EPUB 不执行书内脚本，只提取文本和图片。
- DeepSeek 和 MiMo 的自定义接口地址默认关闭；即使在服务器开启，也会拒绝本机、内网、保留地址，不跟随上游重定向，并且浏览器无权修改地址，降低 SSRF 和 API Key 外泄风险。
- EPUB 限制文件数和解压大小，拒绝实体声明和内部 DTD，不请求外部 DTD；阅读导入的 PDF 限制页数和提取文本量。
- PDF 翻译仅接入明确配置的内网、回环或 Tailscale IP 地址，不跟随重定向。该服务会收到文档和 DeepSeek Key，应独立保护其访问权限。

如果通过公网访问本工具，必须在 Nginx、Caddy 或 Cloudflare 上配置 HTTPS，并设置 `SESSION_COOKIE_SECURE=true`。使用 Cloudflare 时应选择 `Full (strict)`，避免 Cloudflare 到源站之间退回明文 HTTP。浏览器请求里的密码不是客户端哈希值，而是由 HTTPS 连接加密传输；服务端 `.env` 仍属于必须保护的敏感文件。

示例配置为了兼容当前部署，设置了 `ALLOW_ROOT_RUN=true`，因此允许服务由 root 启动。如果删除该配置或改为 `false`，程序会拒绝以 root 启动或处理请求。这个开关只是显式解除保护，并不能降低 root 服务被利用后的系统风险；公开部署仍建议使用单独低权限用户，并交给 systemd、gunicorn 或类似进程管理器管理。

如果之前曾用 root 运行，切换用户前要把 `.env`、`config/`、`logs/`、`reader_data/` 和 `pdf_data/` 的所有权交给新的服务用户；不要把整个系统目录开放成可写。例如服务用户叫 `trans` 时，可按实际存在的路径执行 `chown -R trans:trans ...`。书籍、缓存、配置和日志会使用尽量收紧的目录/文件权限。

生产环境示例（仍只监听本机，由 Nginx/Caddy 提供 HTTPS）：

导入任务和离线听书任务保存在进程内存中，因此应使用单个 Gunicorn worker，不启用 `--preload`；可以通过线程处理并发网页请求。关闭或刷新浏览器不会中断导入和离线生成任务，在线播放会话则随退出停止；服务、容器或 Gunicorn 工作进程重启会中断正在运行的任务。已经生成的缓存会保留，重新提交后可以继续复用。

```bash
gunicorn --workers 1 --threads 6 --bind 127.0.0.1:31000 app:app
```

也可以直接运行 `python3 app.py`，但这是 Flask 自带服务器，适合开发或单机临时使用。管理页面的“重启服务”会沿用当前启动方式：直接启动或 nohup 启动时创建新 PID 的替代进程，保留启动参数和日志输出；systemd 托管时保留 PID 并重新加载程序；Gunicorn 模式保留主进程、替换 worker。Gunicorn 预加载或 Flask 调试自动重载模式需从启动终端或进程管理器重启。重启会中断当前请求，包括尚未完成的 PDF 上传；已被上游接收的 PDF 任务继续由独立服务处理，Trans 恢复后核对其状态，不会自动重复提交。

## 开发检查

提交前可运行：

```bash
python3 -m py_compile app.py reader_search.py pdf_translation.py scripts/migrate_wav_cache_to_m4a.py
for file in static/*.js; do node --check "$file"; done  # 需安装 Node.js
python3 -m pip check
ffmpeg -version
ffprobe -version
```

推送到 `master` 或向 `master` 提交 Pull Request 时，GitHub Actions 会在 Python 3.11、3.12 和 3.13 上安装依赖，检查 Python 与 JavaScript 语法并导入应用。工作流见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

## 许可证

- 项目代码采用 GNU Affero General Public License v3.0，许可证全文见 [`LICENSE`](LICENSE)。
- 如果修改后作为在线服务提供给用户使用，需要按 AGPL-3.0 向这些用户提供对应源码。
- `static/fonts/` 中的字体不适用项目 AGPL；其版权和再分发条件见 [`FONT_LICENSES.md`](static/fonts/FONT_LICENSES.md) 与 [`OFL-1.1.txt`](static/fonts/OFL-1.1.txt)。
- 外部贡献默认按 AGPL-3.0 许可进入本项目。

## 致谢

感谢 [Zotero PDF2zh](https://github.com/guaguastandup/zotero-pdf2zh)、[PDFMathTranslate-next](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next) 和 [BabelDOC](https://github.com/funstory-ai/BabelDOC) 的作者与贡献者。PDF 翻译通过 HTTP 调用独立部署的 Zotero PDF2zh 服务，由后两者完成翻译与排版；Trans 不打包上述项目的代码。

上述项目采用 AGPL-3.0，部署和分发时请遵守各自许可证，并参阅上游仓库的使用说明。

本地 PDF 页数识别使用 [PDF-LIB](https://github.com/Hopding/pdf-lib)（MIT 许可），本库及捆绑依赖的许可声明见 `static/vendor/pdf-lib/LICENSES.txt`。

双重验证使用 [PyOTP](https://github.com/pyauth/pyotp)（[MIT](https://github.com/pyauth/pyotp/blob/develop/LICENSE)），本地二维码使用 [Segno](https://github.com/heuer/segno)（[BSD-3-Clause](https://github.com/heuer/segno/blob/master/LICENSE)）；通过 Python 依赖安装，分发时须保留其版权、许可及免责声明。

通行密钥使用浏览器原生 WebAuthn API，服务端验证使用 [py_webauthn](https://github.com/duo-labs/py_webauthn)（[BSD-3-Clause](https://github.com/duo-labs/py_webauthn/blob/master/LICENSE)）；通过 Python 依赖安装，分发时须保留该库及其依赖的许可声明。
