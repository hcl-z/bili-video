import QRCode from 'qrcode-terminal/vendor/QRCode/index.js'

/**
 * 把登录二维码渲染成 SVG，供工作台的系统页显示。
 *
 * 复用 qrcode-terminal 里那份编码器，不为一张码再装第二个 QR 依赖；
 * 它渲染的是终端字符画，矩阵本身在 vendor 那层是通用的。
 */
export function renderQrSvg(text: string): string {
  const qr = new QRCode(-1, 1) // -1 = 自动选版本，1 = 纠错级别 L
  qr.addData(text)
  qr.make()

  const n = qr.getModuleCount()
  // 留 4 模块静默区，少于这个宽度有些扫码器认不出来。
  const quiet = 4
  const size = n + quiet * 2
  const rects: string[] = []
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      if (qr.isDark(row, col)) rects.push(`M${col + quiet} ${row + quiet}h1v1h-1z`)
    }
  }

  // 白底写死：暗色主题下让码跟着变深会直接扫不出来。
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${rects.join('')}" fill="#000"/>` +
    `</svg>`
  )
}
