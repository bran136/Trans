<p align="center">
  <img src="static/site-icon.svg" width="112" height="112" alt="Trans 图标">
</p>

<h1 align="center">Trans</h1>

<p align="center">集在线翻译与在线读书于一体的自部署工具网站</p>

<p align="center">
  <a href="https://github.com/bran136/Trans/releases/latest"><img src="https://img.shields.io/github/v/release/bran136/Trans?display_name=tag&amp;sort=semver&amp;label=%E7%89%88%E6%9C%AC" alt="最新版本"></a>
  <a href="https://github.com/bran136/Trans/actions/workflows/ci.yml"><img src="https://github.com/bran136/Trans/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/bran136/Trans" alt="许可证"></a>
</p>

在线翻译支持 DeepSeek 与谷歌翻译、结果对比、原文高亮、历史记录和翻译缓存；内含 PDF 翻译，支持中英互译、双语对照 PDF 和任务管理。

在线读书支持 TXT/EPUB/PDF 书架、目录与正文搜索、进度同步、字体切换、夜间模式和电脑端 TXT 全文编辑，并提供 Xiaomi MiMo 听书及音频缓存。

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#在线翻译">在线翻译</a> ·
  <a href="#在线读书">在线读书</a> ·
  <a href="#站点管理">站点管理</a> ·
  <a href="#配置与维护">配置与维护</a> ·
  <a href="#许可证与致谢">许可证与致谢</a>
</p>

<details>
<summary>完整目录（点击展开）</summary>

- [功能概览](#功能概览)
- [快速开始](#快速开始)
  - [1. 安装系统依赖（包含音频转换）](#1-安装系统依赖包含音频转换)
  - [2. 下载项目并安装 Python 依赖](#2-下载项目并安装-python-依赖)
  - [3. 配置访问密码](#3-配置访问密码)
  - [4. 选择一种启动方式](#4-选择一种启动方式)
    - [方式一：systemd 系统服务（推荐）](#方式一systemd-系统服务推荐)
    - [方式二：直接启动（调试用）](#方式二直接启动调试用)
    - [方式三：nohup 后台启动（临时使用）](#方式三nohup-后台启动临时使用)
  - [5. 验证并访问网页](#5-验证并访问网页)
  - [6. 配置所需功能](#6-配置所需功能)
- [在线翻译](#在线翻译)
  - [文本翻译](#文本翻译)
    - [DeepSeek 配置和安全](#deepseek-配置和安全)
    - [DeepSeek 缓存与费用](#deepseek-缓存与费用)
    - [DeepSeek 余额](#deepseek-余额)
  - [PDF 论文翻译](#pdf-论文翻译)
- [在线读书](#在线读书)
  - [书籍导入与管理](#书籍导入与管理)
  - [阅读与进度](#阅读与进度)
  - [TXT 全文编辑](#txt-全文编辑)
  - [阅读外观与字体](#阅读外观与字体)
  - [听书](#听书)
    - [听书设置](#听书设置)
    - [播放与定时](#播放与定时)
    - [MiMo 余额](#mimo-余额)
  - [听书缓存](#听书缓存)
    - [播放与缓存机制](#播放与缓存机制)
    - [固定与本机下载](#固定与本机下载)
    - [浏览器保存时间](#浏览器保存时间)
    - [WAV 缓存迁移](#wav-缓存迁移)
- [站点管理](#站点管理)
  - [设置与登录安全](#设置与登录安全)
    - [通行密钥](#通行密钥)
  - [监控](#监控)
  - [日志](#日志)
  - [安全说明](#安全说明)
- [配置与维护](#配置与维护)
  - [环境配置](#环境配置)
    - [站点与登录](#站点与登录)
    - [翻译与听书](#翻译与听书)
  - [更新与排错](#更新与排错)
  - [项目目录](#项目目录)
  - [开发检查](#开发检查)
- [许可证与致谢](#许可证与致谢)
  - [许可证](#许可证)
  - [致谢](#致谢)

</details>

## 功能概览

- 使用共享密码登录，可选开启验证器双重验证（2FA）和一次性恢复码；支持通行密钥，通过设备指纹、人脸或锁屏密码快速登录。不提供注册和用户体系。
- 登录后进入工具入口页，可选择“在线翻译”或“在线读书”。
- 翻译与读书使用独立页面，共用登录入口和登录态；PDF 翻译从在线翻译页打开。
- 主页提供设置、服务监控与关于页面，可管理登录安全、查看运行状态和功能介绍。
- 采用共享访问密码，书架、阅读进度和服务配置由登录用户共用；文本翻译历史和本机音频缓存保存在各自浏览器。
- 提供站点图标和 Web App Manifest；支持的手机浏览器可将网站安装到桌面，以独立窗口打开。
- 页面统一显示“正式版本 + 构建指纹”和 GitHub 入口，例如 `v1.7+7b964961`；页面资源变化后指纹和资源 URL 会自动更新。
- Session Cookie 默认有效期为 30 天。

## 快速开始

以下步骤适用于 **Ubuntu 24.04 / Debian 12、13 等使用 systemd 的 Linux 服务器**，需要可执行 `sudo` 的账户和 Python 3.11–3.13。直接使用当前登录用户运行，无需新建用户。示例安装到 `~/Trans`，也可选择其他有读写权限的目录；其他发行版请替换软件包安装命令。

这是全新安装流程。已有部署请保留原 `.env` 和运行数据，不要重新复制示例配置覆盖它们；切换启动方式前先停止旧进程，避免重复运行和端口冲突。

### 1. 安装系统依赖（包含音频转换）

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends -y git python3 python3-venv python3-pip ffmpeg curl nano ca-certificates
python3 --version
ffmpeg -version
ffprobe -version
```

确认 Python 版本在上述范围内，且 `ffmpeg`、`ffprobe` 均能输出版本信息。MiMo 听书依赖这两个程序将音频转换为 AAC-LC/M4A；应在首次启动前安装，不需要另外安装音频转换插件。

### 2. 下载项目并安装 Python 依赖

```bash
cd ~
git clone https://github.com/bran136/Trans.git
cd Trans
python3 -m venv .venv
.venv/bin/python -m pip install --no-cache-dir -r requirements.txt
.venv/bin/python -m pip check
```

以下部署命令均在项目根目录（包含 `app.py` 的目录）执行。命令直接使用虚拟环境中的程序，**不需要 `source .venv/bin/activate`**。不要使用系统 Python 的 pip 安装项目依赖。

### 3. 配置访问密码

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

在编辑器中修改以下项目，其余先保留示例值。`APP_PASSWORD` 必须换成自己的强密码（至少 12 位）；示例密码不能用于启动。

```env
APP_PASSWORD=请替换为自己的至少12位强密码
HOST=127.0.0.1
PORT=31000
SESSION_COOKIE_SECURE=false
```

普通用户运行可将 `ALLOW_ROOT_RUN` 设为 `false`；如果当前用户是 root，保留示例中的 `true`。

Nano 中按 `Ctrl+O`、回车保存，再按 `Ctrl+X` 退出。API Key 可以先留空，登录后在对应页面的“服务配置”中填写。`SECRET_KEY` 留空即可自动生成；无需手动创建数据目录。

### 4. 选择一种启动方式

三种方式任选其一，**推荐 systemd**：支持开机启动、异常退出后恢复和统一日志管理。

<details>
<summary>Flask 自带服务器与 Gunicorn 的区别</summary>

Trans 负责翻译、阅读和听书；请求服务器负责接收浏览器请求，再交给 Trans。直接运行 `app.py` 使用 Flask 自带服务器，下面的 systemd 示例则使用 Gunicorn。systemd 负责守护进程，两种请求服务器都可以由它管理。

- **日常使用**：只有一两台设备访问时，通常感觉不到明显区别，切换不会改变翻译、听书和缓存功能，也不保证翻译更快或播放更稳定。
- **并发请求**：Flask 自带服务器通常为请求创建线程；本示例的 Gunicorn 使用 6 个请求线程，超过的请求等待处理，请求线程数量更可控，但不一定更快。
- **进程恢复**：systemd 直接运行 `app.py` 时，进程崩溃后由 systemd 重启；使用 Gunicorn 时，它可以重新拉起工作进程，systemd 再守护 Gunicorn。两种方式下，崩溃时正在处理的请求都可能中断。

长期运行推荐 Gunicorn，因为它用于正式提供网络服务；Flask 自带服务器主要用于开发调试，[Flask 官方不建议将其用于正式部署](https://flask.palletsprojects.com/en/stable/deploying/)，个人使用也适用这一建议。

已有部署不必仅为与示例一致而立即切换。切换前应验证听书、后台任务和网页重启按钮，并核对监听地址与端口；不要将切换请求服务器当作播放故障的修复方法。

</details>

#### 方式一：systemd 系统服务（推荐）

使用 Gunicorn 单个工作进程、多线程承载请求，由 systemd 管理。依赖已在第 2 步安装。下面的命令自动填写当前用户名和项目绝对路径，无需手动替换。

```bash
TRANS_DIR="$(pwd -P)"
sudo tee /etc/systemd/system/trans.service > /dev/null <<EOF
[Unit]
Description=Trans translation and reading service
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
User=$(id -un)
WorkingDirectory=${TRANS_DIR}
Environment=PYTHONUNBUFFERED=1
Environment="PATH=${TRANS_DIR}/.venv/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart="${TRANS_DIR}/.venv/bin/python" -m gunicorn --workers 1 --threads 6 --bind 127.0.0.1:31000 app:app
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now trans
sudo systemctl status trans --no-pager
```

状态应为 `active (running)`，接着按第 5 步验证网页。若启动失败，查看 `sudo journalctl -u trans -n 80 --no-pager`。

- 改监听地址或端口：修改服务文件的 `--bind`，随后执行 `sudo systemctl daemon-reload` 和 `sudo systemctl restart trans`。Gunicorn 不读取 `.env` 中的 `HOST`、`PORT`，其他应用配置仍自动从 `.env` 读取，无需添加 `EnvironmentFile`。
- 重启：`sudo systemctl restart trans`；停止：`sudo systemctl stop trans`；取消开机启动并停止：`sudo systemctl disable --now trans`。
- 实时日志：`sudo journalctl -u trans -f`；应用日志同时保存到项目目录下的 `logs/app.log`。

**保持 `--workers 1`，不要添加 `--preload`**。书籍导入、音频生成及部分任务状态在进程内管理，多 worker 会造成请求落到不同进程；线程用于处理并发请求。服务重启会中断本地正在运行的任务，已生成的缓存保留。

#### 方式二：直接启动（调试用）

```bash
.venv/bin/python app.py
```

监听地址和端口取自 `.env`。日志直接显示在终端，按 `Ctrl+C` 停止；关闭终端后不能保证继续运行。这种方式使用 Flask 自带服务器，适合首次排查和临时调试。

#### 方式三：nohup 后台启动（临时使用）

```bash
mkdir -p logs
nohup .venv/bin/python app.py > logs/console.log 2>&1 < /dev/null &
```

监听地址和端口同样取自 `.env`。可关闭 SSH 终端，但不会开机自启，也不会自动恢复崩溃的进程；长期运行请使用 systemd。查看输出：

```bash
tail -f logs/console.log
```

停止时先用 `sudo ss -ltnp 'sport = :31000'` 查找监听进程，将其中的 PID 填入 `sudo kill <PID>`（更换过端口时一并调整）。重启需停止后重新运行启动命令；不要连续执行多次 nohup。网页“重启服务”可能更换 PID，应重新查询。

### 5. 验证并访问网页

在服务器执行：

```bash
curl -I http://127.0.0.1:31000/login
```

收到 `200 OK` 后，说明登录页可访问。地址中的 `127.0.0.1` 指当前机器；在自己电脑上直接打开它不会访问到远程服务器。

首次验证可在**自己电脑的终端**建立 SSH 隧道（替换 SSH 用户和服务器地址，保留此终端）：

```bash
ssh -N -L 31000:127.0.0.1:31000 用户名@服务器地址
```

然后在电脑浏览器打开 `http://127.0.0.1:31000`，输入第 3 步的密码。若本机 31000 端口已占用，将 `-L` 后第一个端口改为 `31001`，浏览器也改用该端口。

手机或公网长期访问请使用 **HTTPS 域名与反向代理**。同机 Nginx/Caddy 或面板的配置要点：

| 项目 | 配置 |
| --- | --- |
| 域名与证书 | 将自己的域名指向服务器，为该域名启用有效的 HTTPS 证书 |
| 代理目标 | `http://127.0.0.1:31000`；容器内的代理需使用实际能访问到 Trans 的地址 |
| 请求头 | 保留原始 `Host`，正确追加 `X-Forwarded-For`，传递 `X-Forwarded-Proto` |
| 上传与等待 | 按需要设置上传大小和响应超时，避免书籍/PDF 上传被代理提前拒绝或中断 |
| `.env` | HTTPS 配好后设 `SESSION_COOKIE_SECURE=true`；`TRUSTED_PROXY_CIDRS` 填代理的实际地址，同机代理一般为 `127.0.0.1,::1` |

修改配置后重启服务，再用 HTTPS 域名登录。Cloudflare 代理须使用 `Full (strict)`，并按[环境配置](#环境配置)补充可信代理网段。通行密钥应在固定的 HTTPS 域名下绑定和使用，无需额外设置域名变量。

### 6. 配置所需功能

- **在线翻译**：进入“服务配置”填写 DeepSeek API Key；谷歌翻译不需要该 Key，但服务器或浏览器需能访问谷歌接口。
- **在线读书**：可直接导入 TXT/EPUB/PDF 阅读；听书需在设置中填写 MiMo API Key，系统 FFmpeg 已在第 1 步安装。
- **PDF 翻译**：需另外部署可访问的 Zotero PDF2zh 服务，并在 PDF 页面配置其内网地址与 DeepSeek Key，详见 [PDF 翻译](#pdf-论文翻译)。未配置时不影响普通翻译和读书。

主要入口为主页 `/`、在线翻译 `/translate`、PDF 翻译 `/translate/pdf`、在线读书 `/reader`。

## 在线翻译

### 文本翻译

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
- 原文与成功翻译的结果显示语言对应的统计：中文按字数，英文按词数。
- 点击翻译结果中的句子会高亮对应原文，句数无法精确对应时退回高亮对应段落。
- 折叠状态会在当前页面会话中保持，刷新后恢复默认。
- 本地浏览器历史记录默认保留 100 条。

#### DeepSeek 配置和安全

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

#### DeepSeek 缓存与费用

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

#### DeepSeek 余额

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

## 在线读书

支持 TXT、EPUB 和带文本层的 PDF。

### 书籍导入与管理

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
- 书籍管理按导入时间由新到旧排序。
- 支持编辑书名和作者、删除书籍、重新解析书籍。
- 书架和书籍管理支持搜索书名、作者。

### 阅读与进度

- 书架按最近打开时间排序并显示当前章节、估算进度和最近打开时间；启动时优先读取轻量索引，不重复解析原书。
- 阅读进度与选句高亮独立：书籍打开后每 5 秒检查最后完整可见的句子，仅在位置变化时保存；听书时记录正在播放的位置。返回书架或离开页面时补存进度。
- 阅读统计按书展示临时缓存、服务器固定及本机下载的容量、章节和覆盖率，点击明细可管理听书缓存。覆盖率按当前听书配置的句数去重计算，索引不足时显示待统计。停止听书 5 秒后或缓存、书籍内容变更后自动更新；手动刷新可重新读取进度并校准缓存统计。
- 支持目录跳转、上一章、下一章；点击章节标题可筛选目录，或切换到“正文”搜索并跳转到匹配位置。首次正文搜索需要稍等片刻。
- 手机端顶部阅读控制区固定，方便长文阅读时切换章节。
- 从具体书籍使用浏览器或手机系统返回键时会先回到书架，再次返回才会离开在线读书。

### TXT 全文编辑

- 电脑端可在“管理 → 编辑 → 编辑 TXT 全文”中修改原文，支持章节导航、查找替换、修改高亮及逐条撤销。
- Ctrl / ⌘ + S 仅保存原文；点击“保存并解析”后才更新阅读内容和目录。读写使用压缩传输，保存时只上传差异，节省流量。
- 同一本书同时只能在一个页面编辑，退出后释放；异常退出后最多等待 5 分钟即可重新进入。
- 自动保留最近一次修改前的原文备份，可下载、删除或载入恢复。备份在下次修改并保存时覆盖，删除书籍时一并删除。

### 阅读外观与字体

- 支持字体大小、字体切换和夜间模式。
- 自定义字体使用 WOFF2 并按需加载，不会在页面启动时下载全部字体。
- 字体设置显示加载状态并支持手动加载；已下载字体保存在浏览器 Cache Storage 中。
- 字体资源使用带内容版本的长期缓存，文件变化后会请求新版本。
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

### 听书

当前听书使用 Xiaomi MiMo TTS：

```text
https://mimo.xiaomi.com/mimo-v2-5-tts
```

#### 听书设置

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

#### 播放与定时

- 双击正文句子，从该句开始朗读。
- 单击句子只更新高亮，不开始朗读，避免误触。
- 当前朗读句子会实时高亮。
- 可以暂停、停止、快速切换音色，并选择 0.8、1、1.2、1.5、2 倍速（默认 1 倍）。
- 可以设置定时暂停，支持 5、10、15、30、45、60 分钟和自定义分钟数。
- 定时暂停会等当前句读完；浏览器支持网页调节音量时，会在结束前渐弱，否则直接在句末暂停。后台效果受浏览器和系统调度影响。
- 浏览器支持 Media Session 时，系统媒体界面会显示书名、章节和站点图标，并提供播放、暂停和停止控制。
- 页面使用 Screen Wake Lock 尽量在前台朗读时保持屏幕常亮；定时暂停、手动暂停或停止后会立即释放。切到后台时浏览器会释放屏幕常亮限制。
- 安装到桌面不会绕过系统省电策略，后台朗读仍受 iOS/Android 和浏览器的音频调度限制。

#### MiMo 余额

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

### 听书缓存

#### 播放与缓存机制

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

#### 固定与本机下载

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

#### 浏览器保存时间

IndexedDB 没有统一的固定保存天数：

- 桌面 Chrome：普通窗口通常可长期保留；清除网站数据、删除浏览器配置或磁盘压力可能导致删除。无痕窗口关闭后删除。
- Android Chrome：普通模式通常可长期保留；清除应用数据、卸载浏览器或系统存储压力会删除。无痕模式关闭后删除。
- macOS Safari：没有固定期限；清除网站数据、长期未访问或磁盘压力可能触发回收。私人浏览关闭后删除。
- iPhone/iPad 浏览器与主屏幕 Web App：缓存可能因系统存储压力、清理网站数据或长期未使用而被回收，不应作为唯一副本。私人浏览的数据通常在会话结束后删除。

在 HTTPS 安全上下文且浏览器支持 Storage API 时，页面显示当前站点的估算用量、浏览器分配额度及持久化状态，例如 `本机存储 1.2 GB / 10.0 GB · 已持久化`；未获持久化授权时显示“可能被回收”。HTTP 下即使浏览器能提供容量估算，也不能申请持久化存储；完全无法估算时显示“HTTP 下无法查询本机容量”。下载前会尝试调用 `navigator.storage.persist()`，是否批准由浏览器决定，Safari 和 iOS 不保证批准。

#### WAV 缓存迁移

当前版本不直接读取 1.1 及更早版本的服务端 WAV 缓存。旧用户若要继续复用这些缓存，必须先停止服务并执行转换；转换不需要重新调用 MiMo。建议首次保留源文件：

```bash
cp -a reader_data reader_data.backup
.venv/bin/python scripts/migrate_wav_cache_to_m4a.py --keep-source
```

转换后启动服务并确认听书正常。确认无误后，再停止服务并运行一次不带 `--keep-source` 的命令，脚本会验证已有 M4A、更新离线引用并删除对应 WAV。转换失败的 WAV 会保留，脚本可以重复运行。

旧浏览器 IndexedDB 中的单句 WAV 无法在本地可靠转换为 M4A 播放包，从旧版本升级时会自动清除旧单句和 v6 之前的分包；服务器缓存转换完成后，在该浏览器重新执行“固定并下载到本地”即可。全新安装不需要运行迁移脚本，正常运行也不会持久化 WAV 文件；MiMo 上游仍以 WAV 返回音频，但只在服务端内存中短暂存在，随后立即转为 M4A。

## 站点管理

### 设置与登录安全

主页“设置”提供双重验证、通行密钥、修改密码和已登录设备：

- **双重验证默认关闭**。点击“绑定验证器”，在弹窗内先验证当前密码，再用支持 TOTP 的验证器扫码或手动添加密钥，最后输入 6 位验证码确认启用。二维码由 Trans 本地生成，无需第三方二维码服务。
- 启用后，密码登录需要再输入验证码。保存好页面提供的 8 个恢复码，每个仅可使用一次，服务器只保存摘要。恢复码可代替验证码；验证后 5 分钟内，可凭当前密码重新生成恢复码或关闭双重验证，避免用完最后一个恢复码后无法恢复。
- 更换验证器时，先验证密码和验证码（或恢复码）关闭双重验证，再重新绑定。重新生成恢复码会使旧恢复码全部失效。
- 修改密码需要验证当前密码；已开启双重验证时，还需验证第二因素。密码至少 12 位，不能与原密码相同。密码或 2FA 设置变更后，其他浏览器需要重新登录，当前浏览器保留登录状态。
- 已登录设备显示浏览器、系统、IP、登录及最近活动时间，可刷新或单独退出某个客户端；退出当前客户端会返回登录页。同一浏览器的标签页共用记录，最近活动不代表实时在线。旧会话在升级后首次访问时补录，退出或过期后从列表移除。
- IP 地区通过 [IP9](https://www.ip9.com.cn/) 的 HTTPS 接口按需查询，无需注册或 API Key；仅发送公网 IP，不发送密码、密钥或浏览器信息。结果在内存中缓存，内网地址不外查。地区是网络归属地估算，不是设备的精确位置；查询失败不影响登录。

验证器和服务器应保持时间自动同步。请将恢复码与密码分开保管；备份、迁移时妥善保存 `config/security.json` 和会话签名密钥。双重验证密钥保存在仅服务用户可读写的私有文件中，并非加密备份；这些文件已加入 Git 忽略规则，不能公开。公网访问仍需 HTTPS。

#### 通行密钥

在“设置 → 通行密钥 → 管理”中添加或删除密钥，最多支持 10 个，可查看名称、添加时间和最近使用时间。添加时先验证身份：未启用 2FA 时使用密码；启用后可选密码或验证码（也支持恢复码）。验证成功后，再填写名称并添加；当前浏览器的添加权限有效期为 10 分钟。

添加后，登录页可选择“使用通行密钥登录”，通过设备指纹、人脸或锁屏密码完成验证，无需再输入网站密码和 TOTP 验证码。生物识别由设备处理，Trans 只保存公钥；密码及原有 2FA 登录方式仍可使用。

通行密钥需要 HTTPS 域名、支持 WebAuthn 的浏览器和已设置的设备锁屏；本机开发可使用 `http://localhost`，服务器 IP 地址不支持。域名自动取自当前访问地址，无需在 Trans 中单独配置；反向代理需保留原始 `Host`（含非默认端口）。密钥按域名绑定，更换域名需重新添加；能否跨设备同步取决于系统或密码管理器。

修改访问密码不会删除已有通行密钥。设备丢失时，应删除对应密钥并退出相关客户端；删除服务器记录后，设备密码管理器中的副本也可自行移除。备份 `config/security.json` 只能保留公钥记录，不能替代设备上的私钥。

### 监控

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

三种启动方式与完整命令见[快速开始](#快速开始)。管理页面的“重启服务”沿用当前启动方式：直接启动或 nohup 创建新 PID 的替代进程；systemd 直接托管 Python 时原地重载；Gunicorn 替换 worker、保留主进程。Gunicorn 预加载或 Flask 调试自动重载模式需从进程管理器重启。

重启会中断当前请求，包括尚未完成的 PDF 上传；已被上游接收的 PDF 任务继续由独立服务处理，Trans 恢复后核对状态，不会自动重复提交。

### 日志

应用日志保存在 `logs/app.log`，单文件约 2 MB，最多保留 5 个轮转备份。查看实时日志：

```bash
tail -f logs/app.log
```

记录登录与限速、配置更新、翻译和听书请求、书籍操作、缓存清理、服务重启及请求拦截等事件。排查问题时请先检查日志；向他人提供日志前应确认其中不含私人内容。

听书播放诊断批量记录播放、缓冲、暂停、定时到期和页面状态，包含书籍编号及播放位置，不包含正文或密钥。未发送记录在当前浏览器最多暂存 48 条，网络恢复或重新打开读书页后尝试补发；系统冻结页面期间无法记录新事件。

### 安全说明

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

服务使用现有账户即可，该账户需能读写项目目录。root 运行需设置 `ALLOW_ROOT_RUN=true`；普通用户无需开启此项。

## 配置与维护

### 环境配置

完整示例见 [`.env.example`](.env.example)。程序自动读取项目根目录的 `.env`，无需在 shell 中 `source` 它。首次部署只需设置访问密码；API Key 及常用参数可在登录后的服务配置中填写。

#### 站点与登录

| 配置项 | 用途 |
| --- | --- |
| `APP_PASSWORD` | 共享访问密码，必须使用至少 12 位的非默认强密码 |
| `HOST` / `PORT` | `python app.py` 的监听地址和端口，示例为 `127.0.0.1:31000`；Gunicorn 使用启动命令的 `--bind` |
| `SECRET_KEY` | 会话签名密钥；留空自动生成到 `config/secret_key`（权限 `0600`），自行填写时至少 32 位随机值 |
| `SESSION_COOKIE_SECURE` | 示例为 `false`；启用 HTTPS 后设为 `true`，普通 HTTP 调试时应为 `false` |
| `TRUSTED_PROXY_CIDRS` | 可信代理 IP 或网段，逗号分隔；默认留空，不信任转发头 |
| `ALLOW_ROOT_RUN` | 是否允许 root 运行；示例为 `true`，普通用户可设为 `false`，root 用户需保留 `true` |

使用反向代理时，`TRUSTED_PROXY_CIDRS` 只填写实际代理地址。同机 Nginx 通常为 `127.0.0.1,::1`；Docker 代理填写实际容器 IP，或仅含可信代理的专用网段。不要填写 `0.0.0.0/0`、`::/0` 等任意来源。

如果还有 Cloudflare，需加入其[官方代理网段](https://www.cloudflare.com/ips/)，并由反向代理正确追加 `X-Forwarded-For`；代理地址变化时同步调整。该项优先读取 `.env`，文件中未设置时才读取进程环境变量；留空可关闭信任。

2FA、恢复码和通行密钥在主页“设置”中管理，不需要额外环境变量。通行密钥绑定当前访问域名，换域名后需重新添加；迁移时应保留 `config/secret_key` 和 `config/security.json`。

#### 翻译与听书

| 配置项 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek API Key，可在在线翻译的服务配置中填写 |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 文本翻译的 API 地址与初始模型，示例使用官方接口 |
| `ALLOW_CUSTOM_DEEPSEEK_BASE_URL` | 默认 `false`；自定义文本翻译网关需显式开启，详见 [DeepSeek 配置和安全](#deepseek-配置和安全) |
| `MIMO_API_KEY` | MiMo API Key，可在听书设置中填写 |
| `MIMO_TTS_BASE_URL` / `MIMO_BALANCE_URL` | MiMo 语音与余额接口，示例使用官方地址 |
| `MIMO_TTS_MODEL` / `MIMO_TTS_VOICE` | 初始听书模型与音色，示例为 `mimo-v2.5-tts`、冰糖 |
| `MIMO_TTS_STYLE_PROMPT` | 初始朗读风格提示词 |
| `ALLOW_CUSTOM_MIMO_BASE_URL` | 默认 `false`；自定义 MiMo 网关需显式开启 |
| `TTS_CACHE_LIMIT_MB` | 单句临时音频缓存上限，范围 10–8192 MB，示例 8192 MB |
| `TTS_CACHE_TTL_DAYS` | 临时音频保留天数，范围 1–365，示例 90 天 |

表中“示例”指复制 `.env.example` 后的配置；删除缓存配置项时，程序的兜底值为 80 MB、7 天。服务器固定音频不按临时缓存规则清理，播放包另有缓存管理，详见[听书缓存](#听书缓存)。

在线翻译和听书的 API Key 保存到 `.env`；PDF 的独立 Key、上游地址与论文参数保存在 `pdf_data/config.json`，在 PDF 页面配置，不需要另写环境变量。前端仅显示密钥配置状态，留空保存不会覆盖原 Key。

`.env` 每行使用 `键=值`，说明注释放在单独一行；需要引号时可用成对的单引号或双引号。不要把真实密码或 Key 写入 `.env.example`。除上述可信代理项外，启动时同名进程环境变量优先于 `.env`；避免在系统服务中重复设置这些应用变量。手动修改 `.env` 后从终端重启服务；页面内保存配置按页面提示生效。

### 更新与排错

按[快速开始中的 systemd 示例](#方式一systemd-系统服务推荐)部署后，进入实际项目目录再执行以下更新命令。更新前备份 `.env`、`config/`、`reader_data/` 和 `pdf_data/`；先结束正在运行的导入、听书等本地任务。

```bash
sudo systemctl stop trans
git pull --ff-only
.venv/bin/python -m pip install --no-cache-dir -r requirements.txt
.venv/bin/python -m pip check
sudo systemctl start trans
sudo systemctl status trans --no-pager
```

每一步成功后再继续；若 Git 提示本地改动冲突，先处理自己的改动，不要强制覆盖。更新依赖不能只重启旧环境。直接启动或 nohup 部署则停止旧进程后执行相同的拉取、依赖安装步骤，再按原方式启动。

| 现象 | 优先检查 |
| --- | --- |
| 启动失败或登录页报错 | `.env` 的密码是否已修改、运行用户是否有权读写项目目录；查看服务和应用日志 |
| 端口已占用 | 旧的 Python、nohup 或系统服务是否仍在运行；三种方式不要同时启动 |
| 本机可访问，域名无法访问 | 域名解析、证书、防火墙和反向代理目标；Docker 代理的 `127.0.0.1` 指容器自身 |
| 登录后仍回到登录页 | 是否用 HTTP 访问却设置了 `SESSION_COOKIE_SECURE=true`，或代理未保留原始域名 |
| 设备 IP 显示为代理 IP | `TRUSTED_PROXY_CIDRS` 和代理转发头是否匹配实际部署 |
| 听书转码失败 | 服务运行环境能否找到 `ffmpeg`、`ffprobe`，磁盘是否有可用空间 |

正式版本见 [`VERSION`](VERSION)，更新记录见 [`CHANGELOG.md`](CHANGELOG.md)。页面版本附带八位构建指纹；修改 Python 文件、版本号或服务器环境配置后，应从终端重启进程（systemd 使用 `systemctl restart trans`），确保重新读取环境。

### 项目目录

以下路径均相对于项目根目录。`.venv/` 在部署时创建，私有配置和运行数据在首次使用相应功能时生成。

```text
app.py                             应用入口、登录安全、在线翻译、阅读与听书
reader_search.py                   书籍正文搜索与索引
pdf_translation.py                 PDF 翻译服务接入、任务与文件管理
templates/                         页面模板
static/                            页面样式、脚本、图标、字体及前端依赖
scripts/migrate_wav_cache_to_m4a.py  旧音频缓存迁移工具
.github/workflows/ci.yml           自动检查流程
VERSION / CHANGELOG.md             正式版本与更新记录
requirements.txt / .env.example    Python 依赖与环境配置示例
.venv/                             Python 虚拟环境
.env                               访问密码、在线翻译与听书 API Key
config/
  service_config.example.json      谷歌翻译接口配置示例
  service_config.json              谷歌翻译接口默认值和备选列表
  app_config.json                  页面保存的普通配置，不保存真实 API Key
  secret_key                       自动生成的会话签名密钥
  security.json                    2FA、通行密钥、登录设备及验证状态（私有）
  deepseek_cache.sqlite3            文本翻译缓存
  mimo_balance_state.json          MiMo 余额、过期状态及余额 Cookie
reader_data/
  books.json                       书架索引
  books/<书籍ID>/                  原书、章节、progress.json、搜索索引及 TXT 备份
  tts_cache/                       单句音频缓存
  tts_pack_cache/                  播放包缓存
  tts_offline.sqlite3              服务器固定音频记录
  tts_pack_index.sqlite3           播放包归属索引
  tts_cache_stats.json             音频缓存统计摘要
pdf_data/
  config.json                      PDF 配置及独立 API Key（如已填写）
  tasks.sqlite3                    PDF 任务记录
  <任务ID>/                        各任务上传原文与翻译结果
logs/app.log                       应用日志（自动轮转）
```

`.env`、实际配置、书籍、PDF 文件、缓存和日志等私有运行数据已加入 `.gitignore`。迁移或备份时应一并保护这些文件，不要提交到公开仓库。系统服务文件位于 `/etc/systemd/system/trans.service`，不在项目目录内；nohup 示例另有 `logs/console.log`，该文件不会自动轮转。

### 开发检查

提交前可运行：

```bash
.venv/bin/python -m py_compile app.py reader_search.py pdf_translation.py scripts/migrate_wav_cache_to_m4a.py
for file in static/*.js; do node --check "$file"; done  # 需安装 Node.js
.venv/bin/python -m pip check
ffmpeg -version
ffprobe -version
```

推送到 `master` 或向 `master` 提交 Pull Request 时，GitHub Actions 会在 Python 3.11、3.12 和 3.13 上安装依赖，检查 Python 与 JavaScript 语法并导入应用。工作流见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

## 许可证与致谢

### 许可证

- 项目代码采用 GNU Affero General Public License v3.0，许可证全文见 [`LICENSE`](LICENSE)。
- 如果修改后作为在线服务提供给用户使用，需要按 AGPL-3.0 向这些用户提供对应源码。
- `static/fonts/` 中的字体不适用项目 AGPL；其版权和再分发条件见 [`FONT_LICENSES.md`](static/fonts/FONT_LICENSES.md) 与 [`OFL-1.1.txt`](static/fonts/OFL-1.1.txt)。
- 外部贡献默认按 AGPL-3.0 许可进入本项目。

### 致谢

感谢 [Zotero PDF2zh](https://github.com/guaguastandup/zotero-pdf2zh)、[PDFMathTranslate-next](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next) 和 [BabelDOC](https://github.com/funstory-ai/BabelDOC) 的作者与贡献者。PDF 翻译通过 HTTP 调用独立部署的 Zotero PDF2zh 服务，由后两者完成翻译与排版；Trans 不打包上述项目的代码。

上述项目采用 AGPL-3.0，部署和分发时请遵守各自许可证，并参阅上游仓库的使用说明。

本地 PDF 页数识别使用 [PDF-LIB](https://github.com/Hopding/pdf-lib)（MIT 许可），本库及捆绑依赖的许可声明见 `static/vendor/pdf-lib/LICENSES.txt`。

双重验证使用 [PyOTP](https://github.com/pyauth/pyotp)（[MIT](https://github.com/pyauth/pyotp/blob/develop/LICENSE)），本地二维码使用 [Segno](https://github.com/heuer/segno)（[BSD-3-Clause](https://github.com/heuer/segno/blob/master/LICENSE)）；通过 Python 依赖安装，分发时须保留其版权、许可及免责声明。

通行密钥使用浏览器原生 WebAuthn API，服务端验证使用 [py_webauthn](https://github.com/duo-labs/py_webauthn)（[BSD-3-Clause](https://github.com/duo-labs/py_webauthn/blob/master/LICENSE)）；通过 Python 依赖安装，分发时须保留该库及其依赖的许可声明。
