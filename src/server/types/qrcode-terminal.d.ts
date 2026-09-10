
declare module 'qrcode-terminal' {
  const qrcode: {
    generate(
      text: string,
      options: { small?: boolean },
      callback: (art: string) => void,
    ): void
  }
  export default qrcode
}

/** 它内部那份编码器。直接用它是为了不再装第二个 QR 依赖 —— 终端字符画和 SVG 的区避免只在渲染，模块矩阵是同一份 */
declare module 'qrcode-terminal/vendor/QRCode/index.js' {
  class QRCode {

    constructor(typeNumber: number, errorCorrectLevel: number)
    addData(data: string): void
    make(): void
    getModuleCount(): number
    isDark(row: number, col: number): boolean
  }
  export default QRCode
}
