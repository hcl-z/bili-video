/**
 * qrcode-terminal 没带类型。它是 CJS，cjs-module-lexer 只认出 default ——
 * 所以这里只声明 default，且只声明我们真正用到的那一个函数，
 * 免得写一份猜出来的完整 d.ts 反而骗过 tsc。
 */
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

/**
 * 它内部那份编码器。直接用它是为了不再装第二个 QR 依赖 ——
 * 终端字符画和 SVG 的区别只在渲染，模块矩阵是同一份。
 */
declare module 'qrcode-terminal/vendor/QRCode/index.js' {
  class QRCode {
    /** typeNumber < 1 = 按内容自动选版本；errorCorrectLevel: L=1 M=0 Q=3 H=2。 */
    constructor(typeNumber: number, errorCorrectLevel: number)
    addData(data: string): void
    make(): void
    getModuleCount(): number
    isDark(row: number, col: number): boolean
  }
  export default QRCode
}
