declare module 'qrcode' {
  const QRCode: {
    create(text: string, options: { errorCorrectionLevel: 'H' | 'M' }): { modules: { size: number } }
  }
  export default QRCode
}
