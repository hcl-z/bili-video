import qrcode from 'qrcode-terminal'

/**
 * 把登录二维码渲染成终端里能扫的字符画。
 *
 * 返回字符串而不是直接 print：一是能被测试断言，二是让调用方决定送去哪儿
 * （stdout 给人扫，日志里则只记一句「二维码已打印」—— 把字符画写进日志文件毫无意义）。
 */
export function renderQr(text: string): Promise<string> {
  return new Promise((resolve) => {
    // small: true 才能在常规高度的终端里完整显示，否则要滚屏，扫不上。
    qrcode.generate(text, { small: true }, (art) => resolve(art))
  })
}
