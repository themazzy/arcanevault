import fs from 'node:fs'
import path from 'node:path'

const targetPath = path.join(
  process.cwd(),
  'node_modules',
  '@capacitor-community',
  'camera-preview',
  'android',
  'src',
  'main',
  'java',
  'com',
  'ahm',
  'capacitor',
  'camera',
  'preview',
  'CameraPreview.java',
)

if (!fs.existsSync(targetPath)) {
  console.log('[patch-camera-preview] target not found, skipping')
  process.exit(0)
}

const source = fs.readFileSync(targetPath, 'utf8')
const needle = `                        if (fragment != null && fragment.toBack && fragment.frameContainerLayout != null) {
                            fragment.frameContainerLayout.dispatchTouchEvent(event);
                        }`
const replacement = `                        if (
                            fragment != null &&
                            fragment.toBack &&
                            fragment.frameContainerLayout != null &&
                            event.getPointerCount() > 1
                        ) {
                            fragment.frameContainerLayout.dispatchTouchEvent(event);
                        }`

if (!source.includes(needle)) {
  if (source.includes('event.getPointerCount() > 1')) {
    console.log('[patch-camera-preview] patch already applied')
    process.exit(0)
  }
  console.warn('[patch-camera-preview] expected source snippet not found, skipping')
  process.exit(0)
}

fs.writeFileSync(targetPath, source.replace(needle, replacement))
console.log('[patch-camera-preview] applied Android touch relay patch')
