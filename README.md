# LLM CLI Agent

一个类似 Claude Code 的命令行 AI 助手工具。支持多厂商大模型（Qwen、豆包、DeepSeek、Kimi），浏览器扫码登录，自动进化工具箱，在终端中与 AI 对话并自动调用工具完成任务。

## 工作原理

```
终端输入 ──> 认证 Cookie ──> 厂商网页 API ──> AI 回复 ──> 工具执行 ──> 自动进化
```

1. 首次运行自动打开浏览器，扫码登录对应厂商网站
2. 登录成功后提取 Cookie 保存到本地
3. 后续通过 Cookie 调用对应厂商的内部 API，无需 API Key
4. 每次交互的经验自动记录，系统持续进化

## 支持的厂商

| 厂商 | ID | 登录地址 |
|------|-----|----------|
| 通义千问 | `qwen` | chat.qwen.ai |
| 豆包 | `doubao` | doubao.com |
| DeepSeek | `deepseek` | chat.deepseek.com |
| Kimi | `kimi` | kimi.moonshot.cn |

切换厂商：
```bash
LLM_PROVIDER=doubao npm start
LLM_PROVIDER=deepseek npm start
LLM_PROVIDER=kimi npm start
```

## 功能特性

### 核心功能
- **多厂商支持** — Qwen、豆包、DeepSeek、Kimi 一键切换
- **浏览器登录** — 有浏览器环境：打开窗口扫码；无浏览器环境：截图展示二维码
- **交互式 REPL** — 在终端中与 AI 自由对话
- **多轮工具链** — AI 可以连续调用多个工具完成复杂任务
- **会话持久化** — Cookie 保存 12 小时，无需重复登录

### 自动进化 (Harness)
- **记忆系统** — 自动记住成功的模式、失败的原因、用户偏好
- **自我改进** — 工具调用失败时自动分析原因，积累经验规则
- **自动化钩子** — 配置启动/退出/错误时的自动行为

### 工具能力
| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容（限制在项目目录） |
| `write_file` | 创建或覆盖文件（限制在项目目录） |
| `edit_file` | 精确文本替换（限制在项目目录） |
| `bash` | 执行 Shell 命令 |
| `browser_navigate` | 打开指定 URL |
| `browser_screenshot` | 对当前页面截图 |
| `browser_text` | 提取页面文本内容 |
| `browser_click` | 点击页面上的元素 |
| `browser_type` | 在输入框中输入文本 |

## 安装

```bash
# 克隆仓库
git clone git@github.com:pangpang20/llm_cli.git
cd llm_cli

# 安装依赖
npm install

# 编译 TypeScript
npm run build
```

## 使用

### 前置要求

- **Node.js v22+** — 运行 `node -v` 检查版本
- **npm** — 随 Node.js 一起安装
- **Chrome/Chromium** — Puppeteer 会自动下载，或手动安装 `sudo apt install chromium-browser`
- **Linux 无显示环境** — 需要安装 `xvfb` 或使用截图模式

### 第一步：安装

```bash
# 克隆仓库
git clone git@github.com:pangpang20/llm_cli.git
cd llm_cli

# 安装依赖（会自动下载 Chromium）
npm install

# 编译 TypeScript
npm run build
```

### 第二步：启动（首次登录）

```bash
# 默认使用通义千问
npm start
```

首次运行会自动打开浏览器窗口：

1. 浏览器自动打开，跳转到 **chat.qwen.ai**
2. 页面显示二维码，用 **通义千问 App** 扫码
3. 扫码成功后页面跳转，浏览器自动关闭
4. 认证 Cookie 保存到 `.qwen_session.json`
5. 进入对话界面，可以开始使用

> **注意**：如果提示登录超时或失败，检查网络是否能访问 chat.qwen.ai

### 第三步：开始对话

启动成功后看到 `> ` 提示符，直接输入自然语言指令：

```
> 帮我创建一个 Hello World 的 Python 脚本
```

AI 会调用工具（创建文件、执行命令等）完成任务。多步任务会自动串联执行。

### 第四步：切换其他厂商

```bash
# 使用豆包
LLM_PROVIDER=doubao npm start

# 使用 DeepSeek
LLM_PROVIDER=deepseek npm start

# 使用 Kimi
LLM_PROVIDER=kimi npm start
```

首次切换新厂商时会再次打开浏览器，扫码登录对应平台。登录后 Cookie 保存 12 小时，期间无需重复登录。

## 详细使用指南

### 常用对话示例

```
> 读取当前目录下 package.json 的内容

> 把 src/index.ts 里的 chalk.red 全部改成 chalk.yellow

> 运行 npm run build 并告诉我结果

> 打开 https://example.com 截图给我看
```

AI 会自动调用工具完成任务，返回结果后继续对话。

### 内置命令

在对话中输入以下命令：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/clear` | 清空当前对话历史 |
| `/login` | 重新打开浏览器登录（Cookie 过期时使用） |
| `/provider` | 列出所有可用的 AI 厂商 |
| `/memory` | 查看已学习的记忆和失败记录 |
| `/quit` 或 `/exit` | 退出程序 |

### 无浏览器 Linux 服务器登录

在纯终端的 Linux 服务器上有两种方式：

**方式一：从其他机器复制 Session 文件（推荐）**

1. 在你本地电脑上运行 `npm start`，完成登录
2. 找到项目目录下的 `.qwen_session.json` 文件
3. 将该文件复制到服务器的项目目录：
   ```bash
   scp .qwen_session.json user@server:/path/to/llm_cli/
   ```
4. 在服务器上直接运行 `npm start`，无需重新登录

**方式二：截图模式**

```bash
# 设置 NO_SANDBOX=1 启动截图模式
NO_SANDBOX=1 npm start
```

程序会将登录页面的截图以 base64 格式输出到终端。你需要：
1. 将 base64 字符串解码为图片查看
2. 用手机扫码（可以通过另一台设备打开对应网址）
3. 扫码后程序会继续等待并检测登录状态

### Session 管理

| 文件 | 说明 |
|------|------|
| `.qwen_session.json` | Qwen 认证 Cookie，12 小时过期 |
| `.doubao_session.json` | 豆包认证 Cookie |
| `.deepseek_session.json` | DeepSeek 认证 Cookie |
| `.kimi_session.json` | Kimi 认证 Cookie |
| `.llm_memory.json` | 自动进化记忆文件 |
| `.llm_rules.json` | 自动学习的规则 |
| `.llm_hooks.json` | 自动化钩子配置 |

```bash
# 强制重新登录
rm .qwen_session.json
npm start

# 查看自动学习到的经验
# 在对话中输入 /memory 查看，或直接：
cat .llm_memory.json
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_PROVIDER` | `qwen` | 选择 AI 厂商（qwen/doubao/deepseek/kimi） |
| `NO_SANDBOX` | `0` | 设为 `1` 时禁用浏览器沙箱（Docker/CI 环境） |

## 开发

```bash
# 监听模式，自动重新编译
npm run dev

# 手动编译
npm run build

# 类型检查
npm run lint
```

## 项目结构

```
src/
  index.ts                - REPL 主循环入口
  providers/
    base.ts               - Provider 基类（通用登录、会话管理）
    qwen.ts               - Qwen 提供商
    doubao.ts             - 豆包提供商
    deepseek.ts           - DeepSeek 提供商
    kimi.ts               - Kimi 提供商
    index.ts              - 提供商注册表
  harness/
    memory.ts             - 记忆系统：经验记录与检索
    self_improve.ts       - 自我改进：自动学习规则
    hooks.ts              - 自动化钩子：启动/退出/错误
    index.ts              - Harness 整合
  tools/
    types.ts              - 工具接口定义
    read.ts               - 文件读取
    write.ts              - 文件写入
    edit.ts               - 文件编辑
    bash.ts               - Shell 命令
    browser.ts            - 浏览器自动化
    index.ts              - 工具注册导出
```
