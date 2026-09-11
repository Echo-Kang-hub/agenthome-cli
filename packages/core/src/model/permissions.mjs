import { chmod } from "node:fs/promises";

// 收紧含密钥文件的落盘权限（spec §12）：库文件、项目绑定、项目投影都用这一条路径。
// POSIX 0600；Windows 依赖用户目录 ACL（chmod 在 win32 上是 no-op，不报错、不告警）。
// 失败只警告不抛出：权限收紧失败不应把一次已经成功的写盘变成失败。
export async function restrictPermissions(file, io = console) {
  try {
    await chmod(file, 0o600);
  } catch (error) {
    io.warn?.(`Warning: could not restrict permissions on ${file} (${error.code ?? error.message})`);
  }
}
