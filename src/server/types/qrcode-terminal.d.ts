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
