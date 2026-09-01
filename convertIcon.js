const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');

async function convert() {
  try {
    const avifPath = path.join(__dirname, 'assets', 'Paymongo.avif');
    const pngPath = path.join(__dirname, 'assets', 'icon.png');
    const icoPath = path.join(__dirname, 'assets', 'icon.ico');

    // Convert AVIF to PNG
    await sharp(avifPath)
      .resize(256, 256)
      .png()
      .toFile(pngPath);
    console.log('Converted AVIF to PNG');

    // Convert PNG to ICO
    const buf = await pngToIco(pngPath);
    fs.writeFileSync(icoPath, buf);
    console.log('Converted PNG to ICO');

  } catch (err) {
    console.error('Error converting icon:', err);
  }
}

convert();
