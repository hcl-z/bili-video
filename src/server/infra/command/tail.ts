/** 外部命令失败时，报错信息取 stderr 最后几行 —— 前面全是进度输出，看了没用。 */
export const tail = (s: string): string =>
  s
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-3)
    .join(' / ')
    .slice(0, 500)
