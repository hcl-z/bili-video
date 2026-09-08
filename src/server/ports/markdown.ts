/**
 * 总结落盘。返回真实写入的路径 —— 「文件到底在哪」是要显示给人看的，
 * 不该让调用方再自己拼一遍目录。
 */
export interface MarkdownWriter {
  write(name: string, content: string): Promise<string>
}
