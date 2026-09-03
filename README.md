# frp-visitor-stdio

将 frpc visitor 的本地 TCP 端口转换为标准输入/输出流，适合配合 SSH `ProxyCommand` 使用。

程序会读取 frpc TOML 配置，启动或复用 `frpc`，连接选定 visitor 的 `bindAddr:bindPort`，然后在 stdin/stdout 与 Socket 之间转发数据。

## 环境要求

- [Bun](https://bun.sh/)（用于运行代理程序）
- 已安装并可从 `PATH` 找到的 `frpc`
- 一个包含 `[[visitors]]` 配置的 frp TOML 文件

安装项目依赖：

```bash
bun install
```

### frpc visitor 配置示例

```toml
serverAddr = "frp.example.com"
serverPort = 7000

[[visitors]]
name = "ssh"
type = "stcp"
serverName = "ssh-server"
secretKey = "change-me"
bindAddr = "127.0.0.1"
bindPort = 6000
```

`bindPort` 必须是 `1` 到 `65535` 的整数。`bindAddr` 可省略，默认使用 `127.0.0.1`。

## 使用方式

参数格式为：

```text
frp-visitor-stdio <config.toml> [visitorName]
```

第二个参数按 visitor 的 `name` 精确匹配，配置中只有一个 visitor 时可省略。

配置包含多个 visitor 且未指定名称时，程序会报错并退出。

### 配合 SSH 使用

在 `~/.ssh/config` 中加入：

```sshconfig
Host frp-ssh
    HostName ignored
    User remote-user
    ProxyCommand /path/to/frp-visitor-stdio.js /path/to/frpc.toml ssh
```

之后可以直接连接：

```bash
ssh frp-ssh
```

## 会话复用与临时状态

同一个配置文件和 visitor 的并发连接会复用同一个 `frpc` 进程。当最后一个连接结束时，程序会终止该 `frpc`。

锁文件和会话状态文件写入系统临时目录（在 Linux 通常是 `/tmp`），文件名中的 ID 为：

```text
SHA-256(`${configPath}-${visitorName}`)
```

对应文件后缀为 `.lock` 和 `.sessions`。状态文件使用临时文件加原子重命名写入，进程异常退出后，后续会话会清理失效的 PID。

程序连接 visitor 端口时会自动重试，等待 `frpc` 完成端口监听；连接失败或 `frpc` 异常退出时会返回非零退出码。

## 构建

```bash
bun run bundle
```
构建产物为 `dist/frp-visitor-stdio.js`。

## 架构

主要源码模块：

- `src/config.ts`：命令行参数、TOML 和 visitor 配置校验
- `src/session.ts`：锁、会话状态和 `frpc` 生命周期
- `src/stdio-bridge.ts`：TCP 重试及 stdin/stdout 转发
- `src/main.ts`：程序入口和退出信号处理
