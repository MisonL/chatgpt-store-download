---
name: chatgpt-store-links-skill
description: 当用户需要不依赖商店界面获取微软官方 ChatGPT Work/Codex Windows MSIX 临时下载直链时使用。支持 macOS、Linux、Windows 和 WSL 上的 Node.js、NVM 等常见运行方式；通过 StoreEdge 和 FE3 查询并校验目标架构、包身份、摘要和 CDN 响应；默认兼容模式跳过 TLS 证书校验并明确标记，可用 --strict-tls 恢复严格校验；不下载完整文件、不安装应用、不绕过微软许可。
---

# ChatGPT Store Links Skill

这个 Skill 只负责发现并校验微软官方 ChatGPT Work/Codex（产品 ID `9PLM9XGG6VKS`）的 Windows MSIX 临时直链和元数据。它不是完整离线安装器：不会把大文件写入磁盘，不获取许可证，不登录 Microsoft Store，不安装应用，也不修改系统设置。

按当前兼容性策略，脚本默认跳过 TLS 证书校验，以适配缺少 Microsoft Update 根证书的环境；结果会明确标记 `tls_verified: false` 并显示安全警告。需要严格校验时必须显式使用 `--strict-tls`。只有严格模式下所有必需阶段成功且整体 `ok: true` 时，`tls_verified` 才为 `true`；失败、部分失败或兼容模式均为 `false`，而 `tls_verification_enabled` 只表示所选模式。

## 运行要求

- 需要 Node.js 14 或更高版本；推荐使用当前仍受支持的 LTS 版本（本轮验证为 Node.js 24）。低于 14 的版本不受支持，过旧版本可能在版本检查前因语法或运行时能力不足而失败。
- 脚本只使用 Node.js 标准库，不需要 npm 包，可在 macOS、Linux 或 Windows 主机运行。输出始终是给 Windows 使用的 MSIX，不能当作 macOS 或 Linux 原生安装包。
- Windows CMD 若中文显示异常，可先执行 `chcp 65001`；PowerShell 和新版 Windows Terminal 通常不需要调整。
- 本轮已在 macOS Node.js 24.19、Windows 10（10.0.19045）原生 Node.js 24.14、该 Windows 的 WSL Node.js 24.14，以及 Ubuntu 24.04（通过 NVM 加载默认 Node.js 24.14）上通过内置自测；其他 Node.js 版本、Windows/Linux 版本及不同精简组件组合仍需单独验收，不能仅凭版本守卫宣称完整兼容。
- Node.js 的安装来源可以是系统包管理器、NVM/nvm-windows、Volta、asdf、mise、nodenv、fnm、nvs 或 n；Skill 不依赖具体来源，只要求当前 shell 中的 `node` 可执行且版本至少为 14。结果中的 `runtime.node_source_hint` 只是根据环境变量和可执行文件位置给出的提示，不是安装来源证明。
- Skill 目录必须位于 Codex 当前配置的技能搜索路径中；若安装器默认写入的 `.Agents/skills` 未被当前 Codex 扫描，请使用安装器的 `--target` 指向实际 skills 目录。

## WSL、换行和中文编码

- WSL1/WSL2 可以运行查询层，但必须在 WSL 内安装 Node.js 14+，并确保 Skill 文件位于 WSL 文件系统或可访问的 `/mnt/<盘符>/...` 路径。WSL 的 Node.js、环境变量、证书库和 `~/.Agents` 与 Windows 侧相互独立；除非明确需要，不要在 WSL 中混用 `node.exe` 和 Linux `node`。
- 非登录 SSH、服务或计划任务可能没有 `WSL_INTEROP`、`WSL_DISTRO_NAME`、`WSLENV` 等变量；脚本会在 Linux 内核版本包含 `Microsoft` 或 `WSL` 标记时回退识别。该字段仅用于运行环境诊断，不改变下载目标或安装能力判断。
- Linux 上如果 Node.js 由 NVM 管理，非交互 SSH 或脚本任务不会必然自动加载 NVM。运行前应在 NVM 支持的 bash/zsh 上显式加载 `~/.nvm/nvm.sh` 并选择目标版本，例如 `. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use default`，再执行 `node ...`；如果当前 shell 不兼容 NVM，直接调用 `~/.nvm/versions/node/<版本>/bin/node`。不要因为未加载 NVM 时 `node` 命令不存在，就判定系统未安装 Node.js。
- 使用其他版本管理器时也要在同一个命令上下文中初始化它的 PATH；如果 `node --version` 已经能返回版本号，则无需让 Skill 识别或控制版本管理器。非交互任务不要假定 `.bashrc`、`.zshrc` 或 PowerShell 配置一定会被加载。若直接执行脚本时提示 `node` 不存在，应先检查版本管理器的初始化脚本和实际 `node` 路径，再判定是否缺少运行时。
- WSL 不能在 Linux 环境内部署或启动 Windows MSIX。Skill 在 WSL 中得到的 URL 需要交给 Windows 侧下载和安装；若外层下载器写入 Windows 磁盘，可使用 `/mnt/c/Users/<用户名>/...`，但本 Skill 自身不会写文件。
- 当前三个文件均为 UTF-8、无 BOM、LF 换行。Node.js 可以解析 CRLF 源码，但在 WSL 直接执行 `./fetch_links.js` 时，CRLF 可能使 shebang 携带回车字符；跨环境分发应保留 LF，或使用 `node fetch_links.js ...` 显式启动。脚本启动时会将 stdout/stderr 默认编码设为 UTF-8。
- WSL 终端通常使用 UTF-8；中文显示异常时检查 `LANG`/`LC_ALL` 是否为 UTF-8。Windows CMD 使用 `chcp 65001`。PowerShell 5.1 的重定向编码与 PowerShell 7 不同，自动化应优先读取 `--json` 的标准输出，不要依赖屏幕文本或默认重定向编码；终端自身的代码页仍可能影响直接显示。
- 脚本使用直连 HTTPS，不读取 `HTTP_PROXY`/`HTTPS_PROXY` 等代理变量。若 WSL 或 Windows 只能通过代理访问微软服务，当前 Skill 可能无法连通；不要因此放宽主机白名单或改用第三方镜像。

## 各平台启动方式

- 安装器：如果 npm registry 已发布包，可运行 `npx --yes @mison/chatgpt-store-links-skill`；如果尚未发布，可运行 `npx --yes github:MisonL/chatgpt-store-links-skill`。npm 12 默认可能禁止 Git 包，出现 `EALLOWGIT` 时使用 `npx --yes --allow-git=root github:MisonL/chatgpt-store-links-skill`；如果 npm 不支持 Git 源，改在仓库根目录运行 `node bin/install.js`。`npx --yes` 需要 npm 7+；npm 6 可去掉 `--yes` 并在提示时确认。安装器默认写入 `$HOME/.Agents/skills/chatgpt-store-links-skill`（Windows 为 `%USERPROFILE%\\.Agents\\skills\\chatgpt-store-links-skill`），可用 `--target` 覆盖。安装器只复制 Skill 文件，不下载 MSIX。
- macOS/Linux（系统 Node.js）：`node ./scripts/fetch_links.js --arch x64 --json`。常见可执行文件位置包括 `/usr/bin/node`、`/usr/local/bin/node` 和 Homebrew 的 `/opt/homebrew/bin/node`；部分发行版只提供 `nodejs` 命令，此时应建立当前用户可控的 `node` 命令映射或使用 `nodejs` 直接启动脚本，并确认版本至少为 14。
- macOS/Linux（NVM）：在 bash/zsh 中执行 `. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use default && node ./scripts/fetch_links.js --arch x64 --json`。NVM 初始化脚本依赖具体 shell；若当前 `/bin/sh` 无法加载它，改用 bash/zsh，或直接调用 `~/.nvm/versions/node/<版本>/bin/node`。若使用非默认版本，将 `nvm use default` 换成明确版本；NVM 只需在当前 shell 初始化一次。
- Windows CMD：`chcp 65001 >NUL` 后执行 `node "scripts\\fetch_links.js" --arch x64 --json`。如果 `node` 不在 PATH，先在同一窗口初始化 nvm-windows/Volta 等版本管理器，或使用 `where node` 找到的完整路径；Git Bash/MSYS2 中则使用 Unix 风格路径，并确认不是把 `node.exe` 的 Windows 路径传给 WSL 的 Linux Node.js。
- Windows PowerShell：执行 `node .\\scripts\\fetch_links.js --arch x64 --json`；PowerShell 5.1 保存 JSON 时使用 `Out-File -Encoding utf8` 或直接读取标准输出，避免旧版本重定向编码差异。若使用 nvm-windows、Volta 或其他管理器，必须在当前 PowerShell 会话中让 `Get-Command node` 能找到正确版本。
- WSL：在 WSL shell 内使用 Linux Node.js（必要时先初始化 NVM），执行 `node ./scripts/fetch_links.js --arch x64 --json`；不要把 WSL 里的 Linux Node.js 与 `node.exe` 混用。查询得到的 MSIX 直链必须交给 Windows 侧下载/安装。
- 非交互 SSH、计划任务和服务：不要依赖登录 shell 自动加载配置；将版本管理器初始化与脚本放在同一个命令上下文，运行前先检查 `node --version`，再检查 `node ./scripts/fetch_links.js --self-test --json`。如果 `node --version` 仍失败，先检查 `command -v node`、版本管理器初始化脚本和实际 Node.js 路径，不要直接安装第二份 Node.js。

## 用法

```text
node "<SKILL_DIR>/scripts/fetch_links.js" --arch x64
node "<SKILL_DIR>/scripts/fetch_links.js" --arch arm64 --json
node "<SKILL_DIR>/scripts/fetch_links.js" --arch both --json
node "<SKILL_DIR>/scripts/fetch_links.js" --self-test --json
```

参数：

- `--arch x64|arm64|both`：目标 Windows 架构，默认 `x64`。运行 Skill 的主机架构不能代替目标设备判断；ARM64 设备必须显式使用 `--arch arm64`。
- 当前协议检索范围不含 x86；x86 目标不会被脚本伪装成可安装结果。
- `--product-id`：固定为 `9PLM9XGG6VKS`。产品标题必须为 `ChatGPT`，发布者必须为 `OpenAI`，PackageFamilyName 必须为 `OpenAI.Codex_2p2nqsd0c76g0`。
- `--market US --locale en-us`：StoreEdge 市场和语言，除非用户指定，不要随意更改。
- `--ring Retail`：FE3 发布通道；稳定版使用 `Retail`。
- `--timeout 45`：单次 HTTP 请求超时秒数，必须是 1-300 之间的数字。
- `--json`：输出机器可读 JSON，适合下载器或自动化调用。
- `--redact-url`：隐藏输出中的临时签名查询参数，适合终端日志和 CI；不会改变实际请求 URL。JSON 输出会保留主机和路径，并将 `redact_url` 设为 `true`。
- `--self-test`：运行内置离线回归自测；不访问网络、不读写磁盘，失败退出码为 1。当前包含 22 项检查。
- `--insecure-tls`：跳过 TLS 证书校验；当前为默认模式，可显式写出以增强可读性。结果必须标记 `tls_verified: false`，不得隐瞒。
- `--strict-tls`：启用 TLS 证书和主机名校验；与 `--insecure-tls` 不能同时使用。

带值选项必须使用非空值；如果值缺失、位于命令末尾，或后一个 token 是另一个选项，脚本会返回 `missing_argument_value`，不会把选项名误当成值。两个 TLS 选项同时出现时会在参数阶段停止，不发送网络请求；JSON 会返回 `tls_mode: "conflict"`、`tls_verification_enabled: false`、`tls_verified: false`，并说明“TLS 参数冲突，未执行网络请求”。

脚本不保存 cookie、SOAP 响应或直链。临时签名可能出现在输出中；写入日志时建议使用 `--redact-url`。若调用方要保存 JSON 或下载文件，必须由调用方显式重定向或执行下载，并在目标机重新验收。

## 查询和校验流程

1. 请求 StoreEdge，核对产品 ID、标题、发布者、PackageFamilyName、WuCategoryId、WuBundleId、LastUpdateDateUtc、RevisionId 和支持架构；关键身份和标识字段缺失或格式无效时立即失败；`Platforms` 缺失或为空表示上游未声明架构，脚本会继续交给 FE3 判断，非数组值则失败；存在时每个值必须是已知 Windows 架构（`x86`、`x64`、`arm`、`arm64` 或 `neutral`），未识别值立即失败；仅有 `neutral` 时同样交给 FE3 判断，不能替代目标架构包校验；`ApproximateSizeInBytes` 必须是正的安全整数；无法解析或未选中的 SKU 只记录在受限的 `metadata_warnings` 中，不保存原始响应；目标包候选缺失时仍失败关闭；StoreEdge 的空 `Version` 不作为版本号。
2. 调用 FE3 `GetCookie` 和 `SyncUpdates`，从 `AppxMetadata/@PackageMoniker` 选择目标架构最新的 `OpenAI.Codex_<版本>_<架构>__<publisher-id>`；双下划线后的 `publisher-id` 应与完整 PFN `OpenAI.Codex_<publisher-id>` 的后半段一致。使用 FE3 的 `UpdateInfo/ID` 关联同一更新的扩展文件元数据，使用 `UpdateIdentity@UpdateID` 和 `RevisionNumber` 请求文件 URL；这两个 ID 在 FE3 协议中可能分别是数值关联键和 GUID，不要求相等。只使用同一更新的文件大小、SHA-1、SHA-256 和修改时间。`UpdateInfo` 或 `Update` 缺少或重复 ID、XML，或 `UpdateInfo` 缺少或重复顶层 `UpdateIdentity`、`UpdateID` 或 `RevisionNumber` 时直接失败，不静默跳过或回退到旧版本。
3. 调用 FE3 `GetExtendedUpdateInfo2`，按文件 SHA-1 `FileDigest` 精确匹配 `FileLocation/Url`；同一 `FileLocation` 的摘要或 URL 缺失、重复时失败关闭。不按文件名猜 URL，不跨更新拼接信息，不复用旧签名 URL。FE3 返回的 HTTP CDN 地址只在微软白名单主机、同一路径和查询参数不变时升级为 HTTPS。
4. 对每个架构先做 HTTPS HEAD；状态为 400、403、405、501，或 2xx 缺少有效且大于 0 的 `Content-Length` 时，回退为 `Range: bytes=0-0` 的 GET。HEAD 必须与 FE3 大小一致；206 必须为 `bytes 0-0/<总大小>`、长度为 1 且收到首字节；200 必须报告完整文件大小。若 CDN 返回一个或多个 `Content-Disposition` 文件名，解析器会遵守引号和转义规则，不会把合法带逗号文件名截断；所有文件名都必须与 FE3/包名候选一致且彼此不冲突，并符合 Windows 文件名规则（禁止 `<>:"/\\|?*`、控制字符、尾部空格/点、保留设备名，最长 255 字符）；不完整或无法核对的重复字段直接失败。探针响应头写入 JSON 前会清理控制字符。只在内存中读取探针数据，不写入磁盘。
5. StoreEdge、FE3 Cookie、FE3 SyncUpdates、FE3 URL 和 CDN 探针出现 403、408、425、429、500、502、503、504、超时或可恢复连接错误时，各请求阶段最多尝试 3 次；`501` 仅用于 HEAD 回退，不作为重试状态。每次 CDN/FE3 URL 重试都会重新获取临时签名 URL，并遵守有限退避和 `Retry-After` 上限。证书错误、身份不匹配、摘要/大小/Range 校验错误和无法区分的重复响应不会被静默忽略。

## 输出和退出码

成功结果包含 `ok: true`、TLS 状态、市场、语言、通道、产品元数据、`verification_scope`、不含本机路径的 `runtime` 诊断和 `artifacts`。`runtime` 包含 `environment`（`macos`、`linux`、`windows`、`wsl` 或 `other`）、`platform`、主机架构、Node.js 版本、`node_major`、`node_source_hint` 和 `supported_platform`；来源提示仅依据环境变量和可执行文件位置，不是安装来源证明。默认兼容模式下 `tls_verified` 为 `false`、`tls_verification_enabled` 为 `false`，并带有 `security_warning`；严格模式只有在整体成功且所有必需请求均通过证书校验时才会标记为已验证，任何失败或部分失败结果均为 `false`。每个 artifact 至少包含：

`architecture`、`version`、`package_moniker`、`file_name`、`url`、`resolved_url`、`size_bytes`、`sha256`、`sha1_base64`、`modified_utc`、`url_verified`、`tls_verified`、`probe_method`、`probe_attempts`、`http_status`、`content_length`、`content_range`、`url_checked_at_utc`、`verification_scope`、`hash_source`、`local_hash_verified`。

StoreEdge 产品元数据可能包含 `metadata_warnings`；它只记录最多 16 条受限的无法解析或未选中 SKU 结构问题（包括缺失或无效的 `FulfillmentData`），不包含原始响应内容。

这里的 `url_verified` 只表示 StoreEdge/FE3 元数据与 CDN 探针一致，不表示传输来源已通过证书认证，也不表示完整文件已经下载或完成本地哈希验收；来源认证必须同时检查顶层/对应 artifact 的 `tls_verified: true`。`hash_source` 为 FE3，`local_hash_verified` 为 `false`。`modified_utc`、StoreEdge `LastUpdateDateUtc` 和 FE3 Cookie 过期时间必须是带时区的 ISO 8601 时间戳；FE3 摘要必须是规范填充的标准 Base64，URL-safe 或未填充形式会失败关闭。下载后应在目标机使用 `Get-FileHash`、包清单、ZIP 完整性和签名检查做最终验收。

`--arch both` 会分别处理 x64 和 ARM64：成功架构保留在 `artifacts`，失败架构写入 `errors`；只要有架构失败，整体 `ok` 为 `false`，进程退出码为 1。单架构失败也退出 1。JSON 错误包含 `error_code`、`message`、`stage`、`retryable`、`next_action`，必要时还包含 `architecture`、HTTP 状态、重试等待和尝试次数。

运行 `node fetch_links.js --self-test` 可执行内置离线回归检查（当前 22 项）；`--self-test --json` 返回 `test_count`、`passed`、`failed`、`failures`、`network_accessed`、`disk_accessed` 和不含本机路径的 `runtime` 诊断（平台、Node.js 版本及来源提示）。该自测只验证解析、边界、状态和运行环境诊断逻辑，不证明微软接口、CDN、Windows 安装或许可证可用性。

只有产品身份、包身份、同一更新关联、摘要匹配和 CDN 探针全部通过，才可称为"已获取有效官方临时直链"。只查到 StoreEdge 元数据不等于已得到可下载 URL。

## 安全边界和排障

- 仅允许 `storeedgefd.dsx.mp.microsoft.com`、`fe3.delivery.mp.microsoft.com`、`dl.delivery.mp.microsoft.com` 和 `tlu.dl.delivery.mp.microsoft.com`，请求和重定向必须保持 HTTPS、白名单主机、默认端口，且不含 URL 凭据或片段。不使用第三方镜像。
- 每个请求最多跟随 5 次重定向；超出上限、重定向地址不在对应白名单或响应体超过 64 MiB 时直接失败，不扩大访问范围。
- 默认按兼容性策略跳过 TLS 证书校验，所有结果都必须带安全警告；需要安全验证时使用 `--strict-tls`，并先检查系统时间、根证书、企业 TLS 检查链和 `NODE_EXTRA_CA_CERTS`。不安全模式不能作为发布或来源认证依据。
- 找不到架构或目标包时，检查 `--arch`、市场、语言、Retail 通道、StoreEdge 产品身份、PFN 和包名格式，然后重新查询；`Platforms` 中存在非 `x86`、`x64`、`arm`、`arm64`、`neutral` 的未识别值会失败；不包含请求架构且也不含 `neutral` 时会失败，不要从另一架构、旧版本或旧 URL 拼接结果。
- CDN 返回 HTTP 403 时，优先视为临时签名过期、网络出口策略或架构边缘节点差异；脚本会在可恢复情况下重新获取签名 URL。若 ARM64 仍连续 403，应记录架构、HTTP 状态和尝试次数，作为独立网络/渠道问题处理，不要把 x64 URL 代替 ARM64。
- 临时签名 URL 可能很快失效。重新运行脚本生成新 URL，不要缓存、转发或长期复用旧 URL。
- FE3 返回同一摘要的多个不同 URL、同一包的冲突更新标识或同一更新的冲突文件信息时，脚本会失败关闭；不得自行选择其中一个结果。
- FE3 协议依赖内置设备令牌、已安装更新 ID 列表、协议版本和微软 CDN 白名单。微软接口或主机变更时应先更新并重新做真实探针，不得临时放宽白名单。
- 输出中的 CDN URL 含有短时签名；终端、日志和 JSON 文件可能暴露该签名，应按敏感临时凭据处理，并在失效后重新查询。
- Skill 不检测目标 Windows 内核、依赖、签名或许可证；1809/1909/11、阉割 Store 或完全内网环境的安装可行性必须另行验收。
- 下载后安装失败属于目标 Windows 的系统版本、依赖、签名或许可证问题，不由本 Skill 解决；应另行收集安装错误、包清单和系统组件证据。
